# Fidelity check: what real R apps rely on (docs/test-results.md, "Real-app fidelity").
# Prints one "FID <ok|fail|skip> <check>[: detail]" line per check, then "FID end".
check <- function(name, fn) {
  r <- tryCatch(list(ok = TRUE, d = fn()), error = function(e) list(ok = FALSE, d = conditionMessage(e)))
  d <- gsub("[[:space:]]+", " ", paste(r$d, collapse = " "))
  cat(sprintf("FID %s %s%s\n", if (r$ok) "ok" else "fail", name, if (nzchar(d)) paste0(": ", substr(d, 1, 300)) else ""))
}
cat(sprintf("FID start r %s %s\n", getRversion(), R.version$platform))
check("cran-digest", function() {
  library(digest)
  stopifnot(digest("a", algo = "md5", serialize = FALSE) == "0cc175b9c0f1b6a831c399e269772661")
  paste("digest", packageVersion("digest"), "in", dirname(find.package("digest")))
})
check("cran-jsonlite", function() {
  library(jsonlite)
  stopifnot(identical(fromJSON("[1,2]"), c(1L, 2L)))
  paste("jsonlite", packageVersion("jsonlite"))
})
check("https", function() {
  con <- url("https://cloud.r-project.org/", "r")
  on.exit(close(con))
  l <- readLines(con, n = 1, warn = FALSE)
  paste("libcurl", libcurlVersion())
})
check("tcltk", function() {
  if (!capabilities("tcltk")) stop("capabilities('tcltk') is FALSE")
  suppressWarnings(library(tcltk))
  paste("Tcl", tclVersion())
})
check("capabilities", function() {
  caps <- capabilities()
  want <- c("jpeg", "png", "tiff", "cairo", "libcurl", "iconv", "ICU")
  have <- want[want %in% names(caps)]
  missing <- have[!caps[have]]
  if (length(missing)) stop(paste("missing:", paste(missing, collapse = ", ")))
  paste(have, collapse = " ")
})
check("site-library", function() {
  paste(.libPaths(), collapse = " ; ")
})
cat("FID end\n")
