package icon

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
)

// Setting the icon of an unsigned PE (the NSIS base, modes B and C).
//
// The existing .rsrc section is left exactly where it is, byte for byte. A
// new section (.ibrsrc) is added after the last one, holding a complete new
// resource directory plus the new icon images; the resource data directory
// is pointed at it. Every resource we don't change keeps its data entry's
// RVA into the old section.
//
// Why not rebuild .rsrc in place: NSIS's WriteUninstaller copies the
// installer's own header and patches the uninstaller icon over the
// installer icon's images at file offsets fixed when makensis ran. If .rsrc
// were rebuilt those offsets would land on other data (dialogs, the
// manifest) and corrupt uninstall.exe. Here they still land on the old icon
// images, which nothing references any more, so the patch is harmless.
//
// The NSIS overlay (everything after the last section: the installer's
// compressed data) is kept byte for byte. It moves by the new section's
// size, a multiple of FileAlignment (512 for NSIS), and NSIS finds its data
// by scanning 512-byte-aligned offsets, as it does after resedit-js edits
// (design.md section 5). The base is built with CRCCheck off.

const (
	rtIcon      = 3
	rtGroupIcon = 14
	dirResource = 2
	dirSecurity = 4
	newSecName  = ".ibrsrc"
	// IMAGE_SCN_CNT_INITIALIZED_DATA | IMAGE_SCN_MEM_READ
	newSecChars = 0x40000040
)

// peHeaders holds the offsets SetExeIcon needs.
type peHeaders struct {
	pe, opt, dirs, secs int // offsets of the signature, optional header, data dirs, section table
	nsec, ndirs         int
	secAlign, fileAlign uint32
	sizeOfHeaders       uint32
}

type section struct {
	va, vsize, raw, rawSize uint32
}

func readHeaders(b []byte) (*peHeaders, []section, error) {
	le := binary.LittleEndian
	if len(b) < 0x40 || b[0] != 'M' || b[1] != 'Z' {
		return nil, nil, errors.New("not a PE file")
	}
	h := &peHeaders{pe: int(le.Uint32(b[0x3c:]))}
	if h.pe < 0x40 || h.pe+24 > len(b) || string(b[h.pe:h.pe+4]) != "PE\x00\x00" {
		return nil, nil, errors.New("not a PE file")
	}
	h.nsec = int(le.Uint16(b[h.pe+6:]))
	optSize := int(le.Uint16(b[h.pe+20:]))
	h.opt = h.pe + 24
	if h.opt+optSize > len(b) || optSize < 96 {
		return nil, nil, errors.New("truncated PE header")
	}
	switch le.Uint16(b[h.opt:]) {
	case 0x10b:
		h.dirs = h.opt + 96
		h.ndirs = int(le.Uint32(b[h.opt+92:]))
	case 0x20b:
		h.dirs = h.opt + 112
		h.ndirs = int(le.Uint32(b[h.opt+108:]))
	default:
		return nil, nil, errors.New("unknown PE optional header")
	}
	if h.ndirs <= dirSecurity || h.dirs+8*h.ndirs > h.opt+optSize {
		return nil, nil, errors.New("PE has too few data directories")
	}
	h.secAlign = le.Uint32(b[h.opt+32:])
	h.fileAlign = le.Uint32(b[h.opt+36:])
	h.sizeOfHeaders = le.Uint32(b[h.opt+60:])
	if h.secAlign == 0 || h.fileAlign == 0 {
		return nil, nil, errors.New("bad PE alignment")
	}
	h.secs = h.opt + optSize
	if h.secs+40*h.nsec > len(b) {
		return nil, nil, errors.New("truncated PE section table")
	}
	secs := make([]section, h.nsec)
	for i := range secs {
		s := b[h.secs+40*i:]
		secs[i] = section{va: le.Uint32(s[12:]), vsize: le.Uint32(s[8:]), raw: le.Uint32(s[20:]), rawSize: le.Uint32(s[16:])}
	}
	return h, secs, nil
}

func (h *peHeaders) dir(b []byte, i int) (uint32, uint32) {
	o := h.dirs + 8*i
	return binary.LittleEndian.Uint32(b[o:]), binary.LittleEndian.Uint32(b[o+4:])
}

func align(v, a uint32) uint32 { return (v + a - 1) / a * a }

// rvaSlice returns the file bytes from rva to the end of its section.
func rvaSlice(b []byte, secs []section, rva uint32) ([]byte, bool) {
	for _, s := range secs {
		n := s.rawSize
		if s.vsize < n && s.vsize != 0 {
			n = s.vsize
		}
		if rva >= s.va && rva < s.va+n {
			off := int64(s.raw) + int64(rva-s.va)
			end := int64(s.raw) + int64(n)
			if end > int64(len(b)) || off > end {
				return nil, false
			}
			return b[off:end], true
		}
	}
	return nil, false
}

// Resource tree ------------------------------------------------------------

type resNode struct {
	name     []uint16 // nil for an ID entry
	id       uint32
	children []*resNode // for directories
	leaf     *resLeaf   // for data
}

type resLeaf struct {
	rva, size, codepage uint32 // an existing resource
	data                []byte // or new data, placed in the new section
}

// parseRes reads a resource directory whose root is at rootRVA.
func parseRes(b []byte, secs []section, rootRVA uint32) (*resNode, error) {
	area, ok := rvaSlice(b, secs, rootRVA)
	if !ok {
		return nil, errors.New("resource directory is outside the file")
	}
	le := binary.LittleEndian
	count := 0
	var walk func(off uint32, depth int) (*resNode, error)
	walk = func(off uint32, depth int) (*resNode, error) {
		if depth > 3 || uint64(off)+16 > uint64(len(area)) {
			return nil, errors.New("bad resource directory")
		}
		n := int(le.Uint16(area[off+12:])) + int(le.Uint16(area[off+14:]))
		count += n
		if count > 100000 || uint64(off)+16+8*uint64(n) > uint64(len(area)) {
			return nil, errors.New("bad resource directory")
		}
		node := &resNode{}
		for i := 0; i < n; i++ {
			e := area[off+16+uint32(8*i):]
			nameF, dataF := le.Uint32(e), le.Uint32(e[4:])
			c := &resNode{}
			if nameF&0x80000000 != 0 {
				so := nameF &^ 0x80000000
				if uint64(so)+2 > uint64(len(area)) {
					return nil, errors.New("bad resource name")
				}
				l := uint32(le.Uint16(area[so:]))
				if uint64(so)+2+2*uint64(l) > uint64(len(area)) {
					return nil, errors.New("bad resource name")
				}
				c.name = make([]uint16, l)
				for j := range c.name {
					c.name[j] = le.Uint16(area[so+2+2*uint32(j):])
				}
			} else {
				c.id = nameF
			}
			if dataF&0x80000000 != 0 {
				sub, err := walk(dataF&^0x80000000, depth+1)
				if err != nil {
					return nil, err
				}
				c.children = sub.children
			} else {
				if uint64(dataF)+16 > uint64(len(area)) {
					return nil, errors.New("bad resource data entry")
				}
				d := area[dataF:]
				c.leaf = &resLeaf{rva: le.Uint32(d), size: le.Uint32(d[4:]), codepage: le.Uint32(d[8:])}
			}
			node.children = append(node.children, c)
		}
		return node, nil
	}
	return walk(0, 1)
}

func (n *resNode) find(id uint32) *resNode {
	for _, c := range n.children {
		if c.name == nil && c.id == id {
			return c
		}
	}
	return nil
}

// sortChildren puts named entries first (keeping their order, which the
// file's author sorted) then IDs ascending, as the PE format requires.
func (n *resNode) sortChildren() {
	sort.SliceStable(n.children, func(i, j int) bool {
		a, b := n.children[i], n.children[j]
		if (a.name != nil) != (b.name != nil) {
			return a.name != nil
		}
		return a.name == nil && a.id < b.id
	})
}

// serialize lays the tree out as a section placed at rva: directory tables,
// then data entries, then names, then the new data.
func (root *resNode) serialize(rva uint32) []byte {
	var tables []*resNode
	tableOff := map[*resNode]uint32{}
	var leaves []*resNode
	var named []*resNode
	queue := []*resNode{root}
	off := uint32(0)
	for len(queue) > 0 {
		n := queue[0]
		queue = queue[1:]
		tables = append(tables, n)
		tableOff[n] = off
		off += 16 + 8*uint32(len(n.children))
		for _, c := range n.children {
			if c.name != nil {
				named = append(named, c)
			}
			if c.leaf != nil {
				leaves = append(leaves, c)
			} else {
				queue = append(queue, c)
			}
		}
	}
	leafOff := map[*resNode]uint32{}
	for _, l := range leaves {
		leafOff[l] = off
		off += 16
	}
	nameOff := map[*resNode]uint32{}
	for _, n := range named {
		nameOff[n] = off
		off += 2 + 2*uint32(len(n.name))
	}
	dataOff := map[*resNode]uint32{}
	for _, l := range leaves {
		if l.leaf.data != nil {
			off = align(off, 8)
			dataOff[l] = off
			off += uint32(len(l.leaf.data))
		}
	}
	out := make([]byte, off)
	le := binary.LittleEndian
	for _, t := range tables {
		o := tableOff[t]
		nNamed := 0
		for _, c := range t.children {
			if c.name != nil {
				nNamed++
			}
		}
		le.PutUint16(out[o+12:], uint16(nNamed))
		le.PutUint16(out[o+14:], uint16(len(t.children)-nNamed))
		for i, c := range t.children {
			e := out[o+16+8*uint32(i):]
			if c.name != nil {
				le.PutUint32(e, 0x80000000|nameOff[c])
			} else {
				le.PutUint32(e, c.id)
			}
			if c.leaf != nil {
				le.PutUint32(e[4:], leafOff[c])
			} else {
				le.PutUint32(e[4:], 0x80000000|tableOff[c])
			}
		}
	}
	for _, l := range leaves {
		d := out[leafOff[l]:]
		if l.leaf.data != nil {
			le.PutUint32(d, rva+dataOff[l])
			le.PutUint32(d[4:], uint32(len(l.leaf.data)))
			copy(out[dataOff[l]:], l.leaf.data)
		} else {
			le.PutUint32(d, l.leaf.rva)
			le.PutUint32(d[4:], l.leaf.size)
		}
		le.PutUint32(d[8:], l.leaf.codepage)
	}
	for _, n := range named {
		o := nameOff[n]
		le.PutUint16(out[o:], uint16(len(n.name)))
		for j, c := range n.name {
			le.PutUint16(out[o+2+2*uint32(j):], c)
		}
	}
	return out
}

// SetExeIcon returns a copy of the unsigned PE b whose icon groups all show
// images (from WindowsImages), with a correct PE checksum. b must not carry
// a metadata block yet: append that afterwards, then call FixChecksumFile.
func SetExeIcon(b []byte, images []IconImage) ([]byte, error) {
	le := binary.LittleEndian
	h, secs, err := readHeaders(b)
	if err != nil {
		return nil, err
	}
	if off, _ := h.dir(b, dirSecurity); off != 0 {
		return nil, errors.New("the file is signed; set the icon before signing")
	}
	// The end of the section data: the overlay starts here.
	var dataEnd, virtEnd uint32
	firstRaw := uint32(len(b))
	for _, s := range secs {
		if e := s.va + align(s.vsize, h.secAlign); e > virtEnd {
			virtEnd = e
		}
		if s.rawSize == 0 {
			continue
		}
		if s.raw+s.rawSize > dataEnd {
			dataEnd = s.raw + s.rawSize
		}
		if s.raw < firstRaw {
			firstRaw = s.raw
		}
	}
	if int64(dataEnd) > int64(len(b)) {
		return nil, errors.New("PE sections run past the end of the file")
	}
	if dataEnd%h.fileAlign != 0 {
		return nil, errors.New("PE section data doesn't end on a file-alignment boundary")
	}
	// Room for one more section header.
	hdrEnd := h.secs + 40*h.nsec
	if uint32(hdrEnd+40) > h.sizeOfHeaders || uint32(hdrEnd+40) > firstRaw {
		return nil, errors.New("no room for another PE section header")
	}
	for _, c := range b[hdrEnd : hdrEnd+40] {
		if c != 0 {
			return nil, errors.New("no room for another PE section header")
		}
	}

	// Build the new tree.
	var root *resNode
	if rva, size := h.dir(b, dirResource); rva != 0 && size != 0 {
		if root, err = parseRes(b, secs, rva); err != nil {
			return nil, err
		}
	} else {
		root = &resNode{}
	}
	groups := root.find(rtGroupIcon)
	if groups == nil || len(groups.children) == 0 {
		groups = &resNode{id: rtGroupIcon, children: []*resNode{{id: 1}}}
		root.children = append(root.children, groups)
	}
	lang := uint32(0)
	ids := make([]uint16, len(images))
	for i := range ids {
		ids[i] = uint16(i + 1)
	}
	group := GroupData(images, ids)
	first := true
	for _, g := range groups.children {
		if g.leaf != nil { // malformed: a group without a language level
			g.leaf = nil
		}
		if len(g.children) == 0 {
			g.children = []*resNode{{id: 0}}
		}
		for _, l := range g.children {
			if first && l.name == nil {
				lang, first = l.id, false
			}
			l.children, l.leaf = nil, &resLeaf{data: group}
		}
	}
	// The old icon images are all dropped from the directory (every group
	// now names the new ones), and the new images take ids 1..n.
	icons := root.find(rtIcon)
	if icons == nil {
		icons = &resNode{id: rtIcon}
		root.children = append(root.children, icons)
	}
	icons.children = nil
	for i, im := range images {
		icons.children = append(icons.children, &resNode{id: uint32(ids[i]),
			children: []*resNode{{id: lang, leaf: &resLeaf{data: im.Data}}}})
	}
	root.sortChildren()

	// Lay out the new section.
	newVA := align(virtEnd, h.secAlign)
	rsrc := root.serialize(newVA)
	rawSize := align(uint32(len(rsrc)), h.fileAlign)
	if uint64(len(b))+uint64(rawSize) > 0x7fffffff {
		return nil, errors.New("file too large")
	}

	out := make([]byte, 0, len(b)+int(rawSize))
	out = append(out, b[:dataEnd]...)
	out = append(out, rsrc...)
	out = append(out, make([]byte, int(rawSize)-len(rsrc))...)
	out = append(out, b[dataEnd:]...) // the overlay, unchanged

	s := out[hdrEnd : hdrEnd+40]
	copy(s, newSecName)
	le.PutUint32(s[8:], uint32(len(rsrc)))
	le.PutUint32(s[12:], newVA)
	le.PutUint32(s[16:], rawSize)
	le.PutUint32(s[20:], dataEnd)
	le.PutUint32(s[36:], newSecChars)
	le.PutUint16(out[h.pe+6:], uint16(h.nsec+1))
	le.PutUint32(out[h.opt+8:], le.Uint32(out[h.opt+8:])+rawSize)            // SizeOfInitializedData
	le.PutUint32(out[h.opt+56:], newVA+align(uint32(len(rsrc)), h.secAlign)) // SizeOfImage
	le.PutUint32(out[h.dirs+8*dirResource:], newVA)
	le.PutUint32(out[h.dirs+8*dirResource+4:], uint32(len(rsrc)))
	SetChecksum(out)
	return out, nil
}

// ChecksumOffset returns the file offset of the optional header's CheckSum.
func ChecksumOffset(b []byte) (int, error) {
	h, _, err := readHeaders(b)
	if err != nil {
		return 0, err
	}
	return h.opt + 64, nil
}

// checksum is the PE image checksum (imagehlp's CheckSumMappedFile): the
// 16-bit one's-complement-style sum of the file with the CheckSum field
// counted as zero, folded, plus the file length.
type checksum struct {
	sum     uint64
	n       int64 // bytes seen
	skip    int64 // offset of the CheckSum field
	odd     bool
	oddByte byte
}

func (c *checksum) Write(p []byte) (int, error) {
	for _, v := range p {
		if c.n >= c.skip && c.n < c.skip+4 {
			v = 0
		}
		c.n++
		if !c.odd {
			c.oddByte, c.odd = v, true
			continue
		}
		c.odd = false
		c.sum += uint64(c.oddByte) | uint64(v)<<8
		if c.sum > 0xffffffff {
			c.sum = c.sum&0xffff + c.sum>>16
		}
	}
	return len(p), nil
}

func (c *checksum) value() uint32 {
	s := c.sum
	if c.odd {
		s += uint64(c.oddByte)
	}
	for s>>16 != 0 {
		s = s&0xffff + s>>16
	}
	return uint32(s) + uint32(c.n)
}

// Checksum computes the PE checksum of b.
func Checksum(b []byte, off int) uint32 {
	c := &checksum{skip: int64(off)}
	c.Write(b)
	return c.value()
}

// SetChecksum writes the correct checksum into b.
func SetChecksum(b []byte) error {
	off, err := ChecksumOffset(b)
	if err != nil {
		return err
	}
	binary.LittleEndian.PutUint32(b[off:], Checksum(b, off))
	return nil
}

// FixChecksumFile sets the checksum of a PE on disk (after the metadata
// block is appended, which changes it), streaming so large offline
// installers aren't read into memory.
func FixChecksumFile(path string) error {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer f.Close()
	head := make([]byte, 4096)
	n, err := io.ReadFull(f, head)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) {
		return err
	}
	off, err := ChecksumOffset(head[:n])
	if err != nil {
		return err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	c := &checksum{skip: int64(off)}
	if _, err := io.Copy(c, f); err != nil {
		return err
	}
	var v [4]byte
	binary.LittleEndian.PutUint32(v[:], c.value())
	if _, err := f.WriteAt(v[:], int64(off)); err != nil {
		return fmt.Errorf("writing the PE checksum: %w", err)
	}
	return f.Close()
}
