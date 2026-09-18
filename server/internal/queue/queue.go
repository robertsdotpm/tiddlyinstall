// Package queue runs build jobs on Asynq and keeps the ticket numbers,
// queue positions and wait estimates the front end shows (plan.md 1.8).
package queue

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/hibiken/asynq"
	"github.com/redis/go-redis/v9"
)

// Classes, by what was asked for; Asynq serves them with these priorities.
var Classes = map[string]int{"record": 6, "build": 3, "pack": 1}

const TaskType = "ib:job"

// Job is what's stored per job in Redis (a JSON value).
type Job struct {
	ID       string          `json:"id"`
	Ticket   int64           `json:"ticket"`
	Class    string          `json:"class"`
	Status   string          `json:"status"` // queued, running, done, failed
	Progress string          `json:"progress"`
	Error    *string         `json:"error"`
	Request  json.RawMessage `json:"request"`
	Result   json.RawMessage `json:"result,omitempty"`
	Created  time.Time       `json:"created"`
	Started  *time.Time      `json:"started,omitempty"`
	Finished *time.Time      `json:"finished,omitempty"`
}

type Queue struct {
	rdb    *redis.Client
	client *asynq.Client
	opt    asynq.RedisClientOpt
	// Workers per class, for the ETA.
	Workers int
}

func New(addr string, db, workers int) *Queue {
	opt := asynq.RedisClientOpt{Addr: addr, DB: db}
	return &Queue{rdb: redis.NewClient(&redis.Options{Addr: addr, DB: db}), client: asynq.NewClient(opt), opt: opt, Workers: workers}
}

func (q *Queue) Ping(ctx context.Context) error { return q.rdb.Ping(ctx).Err() }

func key(parts ...string) string {
	k := "ib"
	for _, p := range parts {
		k += ":" + p
	}
	return k
}

func newID() string {
	b := make([]byte, 9)
	rand.Read(b)
	return "j_" + hex.EncodeToString(b)
}

// Submit queues a job and returns it with its ticket number.
func (q *Queue) Submit(ctx context.Context, class string, req json.RawMessage) (*Job, error) {
	if _, ok := Classes[class]; !ok {
		return nil, fmt.Errorf("unknown class %q", class)
	}
	t, err := q.rdb.Incr(ctx, key("ticket")).Result()
	if err != nil {
		return nil, err
	}
	j := &Job{ID: newID(), Ticket: t, Class: class, Status: "queued", Progress: "Waiting in the queue", Request: req, Created: time.Now().UTC()}
	if err := q.Save(ctx, j); err != nil {
		return nil, err
	}
	if err := q.rdb.ZAdd(ctx, key("queued", class), redis.Z{Score: float64(t), Member: j.ID}).Err(); err != nil {
		return nil, err
	}
	payload, _ := json.Marshal(map[string]string{"id": j.ID})
	_, err = q.client.EnqueueContext(ctx, asynq.NewTask(TaskType, payload), asynq.Queue(class),
		asynq.MaxRetry(0), asynq.Timeout(2*time.Hour), asynq.Retention(24*time.Hour))
	if err != nil {
		q.rdb.ZRem(ctx, key("queued", class), j.ID)
		return nil, err
	}
	return j, nil
}

func (q *Queue) Save(ctx context.Context, j *Job) error {
	b, _ := json.Marshal(j)
	return q.rdb.Set(ctx, key("job", j.ID), b, 7*24*time.Hour).Err()
}

func (q *Queue) Get(ctx context.Context, id string) (*Job, error) {
	b, err := q.rdb.Get(ctx, key("job", id)).Bytes()
	if err != nil {
		return nil, err
	}
	j := &Job{}
	return j, json.Unmarshal(b, j)
}

// Position is how many tickets of the same class are queued ahead.
func (q *Queue) Position(ctx context.Context, j *Job) int64 {
	if j.Status != "queued" {
		return 0
	}
	r, err := q.rdb.ZRank(ctx, key("queued", j.Class), j.ID).Result()
	if err != nil {
		return 0
	}
	return r
}

// ETA estimates seconds until the job finishes: the jobs ahead plus this
// one, at the recent average duration, spread over the workers. nil when
// there's no history yet.
func (q *Queue) ETA(ctx context.Context, j *Job, ahead int64) *int64 {
	durs, err := q.rdb.LRange(ctx, key("dur", j.Class), 0, 49).Result()
	if err != nil || len(durs) == 0 {
		return nil
	}
	var sum float64
	for _, d := range durs {
		f, _ := strconv.ParseFloat(d, 64)
		sum += f
	}
	avg := sum / float64(len(durs))
	w := q.Workers
	if w < 1 {
		w = 1
	}
	var secs float64
	switch j.Status {
	case "queued":
		running, _ := q.rdb.SCard(ctx, key("running", j.Class)).Result()
		secs = (float64(ahead+running)/float64(w) + 1) * avg
	case "running":
		if j.Started != nil {
			secs = avg - time.Since(*j.Started).Seconds()
		}
		if secs < 1 {
			secs = 1
		}
	default:
		return nil
	}
	n := int64(secs + 0.5)
	return &n
}

// Depths returns queued jobs per class.
func (q *Queue) Depths(ctx context.Context) map[string]int64 {
	out := map[string]int64{}
	for c := range Classes {
		out[c], _ = q.rdb.ZCard(ctx, key("queued", c)).Result()
	}
	return out
}

// Handler does the work for one job; it reports progress through set.
type Handler func(ctx context.Context, j *Job, progress func(string)) (json.RawMessage, error)

// Serve runs the workers until ctx ends.
func (q *Queue) Serve(ctx context.Context, h Handler) error {
	srv := asynq.NewServer(q.opt, asynq.Config{Concurrency: q.Workers, Queues: Classes,
		Logger: nil, LogLevel: asynq.WarnLevel})
	mux := asynq.NewServeMux()
	mux.HandleFunc(TaskType, func(tctx context.Context, t *asynq.Task) error {
		var p struct{ ID string }
		if err := json.Unmarshal(t.Payload(), &p); err != nil {
			return err
		}
		j, err := q.Get(tctx, p.ID)
		if err != nil {
			return err
		}
		now := time.Now().UTC()
		j.Status, j.Started, j.Progress = "running", &now, "Starting"
		q.rdb.ZRem(tctx, key("queued", j.Class), j.ID)
		q.rdb.SAdd(tctx, key("running", j.Class), j.ID)
		defer q.rdb.SRem(context.Background(), key("running", j.Class), j.ID)
		q.Save(tctx, j)
		res, herr := h(tctx, j, func(s string) {
			j.Progress = s
			q.Save(context.Background(), j)
		})
		end := time.Now().UTC()
		j.Finished = &end
		if herr != nil {
			msg := herr.Error()
			j.Status, j.Error, j.Progress = "failed", &msg, "Failed"
		} else {
			j.Status, j.Result, j.Progress = "done", res, "Done"
			d := end.Sub(*j.Started).Seconds()
			q.rdb.LPush(context.Background(), key("dur", j.Class), strconv.FormatFloat(d, 'f', 2, 64))
			q.rdb.LTrim(context.Background(), key("dur", j.Class), 0, 49)
		}
		q.Save(context.Background(), j)
		return nil // failures are reported on the job, not retried
	})
	go func() {
		<-ctx.Done()
		srv.Shutdown()
	}()
	return srv.Run(mux)
}
