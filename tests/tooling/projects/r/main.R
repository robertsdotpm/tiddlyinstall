# Checks R's own package manager: install.packages at install time, then
# the package is loaded here.
say <- function(state, name, detail) cat(paste0("TOOL ", state, " ", name, ": ", detail, "\n"))

check <- function(name, fn) {
  r <- tryCatch(fn(), error = function(e) e)
  if (inherits(r, "error")) say("fail", name, paste(class(r)[1], conditionMessage(r))) else say("ok", name, r)
}

check("install.packages", function() {
  library(jsonlite)
  paste("jsonlite", as.character(utils::packageVersion("jsonlite")), "loaded")
})
check("install.packages-2", function() {
  library(digest)
  paste("digest", digest::digest("x", algo = "sha256"))
})
check("library-path", function() paste(length(.libPaths()), "library paths, first", .libPaths()[1]))
check("stdlib", function() paste(R.version.string, "|", paste(names(which(capabilities()))[1:4], collapse = ",")))
cat(paste0("TOOL runtime r ", getRversion(), "\n"))
cat("TOOL end\n")
