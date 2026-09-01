// inferspool — submit AI jobs to your home GPU queue from anywhere.
//
// Interactive users can sign in once; scripts can use an API key directly.
// A single static binary with no runtime to install.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

var version = "dev" // set via -ldflags at build time

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	// Ctrl-C during --wait should exit promptly, not abandon a half-drawn line.
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigs
		fmt.Fprintln(os.Stderr)
		os.Exit(130)
	}()

	cmd := os.Args[1]
	args := os.Args[2:]

	var err error
	code := 0

	switch cmd {
	case "login":
		code, err = cmdLogin(args)
	case "logout":
		code, err = cmdLogout(args)
	case "whoami":
		code, err = cmdWhoami(args)
	case "key":
		code, err = cmdKey(args)
	case "password":
		code, err = cmdPassword(args)
	case "webhook":
		code, err = cmdWebhook(args)
	case "admin":
		code, err = cmdAdmin(args)
	case "submit":
		code, err = cmdSubmit(args)
	case "batch":
		code, err = cmdBatch(args)
	case "list", "ls":
		code, err = cmdList(args)
	case "get":
		code, err = cmdGet(args)
	case "watch":
		code, err = cmdWatch(args)
	case "cancel":
		code, err = cmdCancel(args)
	case "rerun", "retry":
		code, err = cmdRerun(args)
	case "delete":
		code, err = cmdDelete(args)
	case "status":
		code, err = cmdStatus(args)
	case "config":
		code, err = cmdConfig(args)
	case "update":
		code, err = cmdUpdate(args)
	case "version", "--version", "-v":
		fmt.Println("inferspool", version)
	case "help", "--help", "-h":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "inferspool: unknown command %q\n\n", cmd)
		usage()
		os.Exit(2)
	}

	if err != nil {
		if errors.Is(err, errAuth) {
			fmt.Fprintln(os.Stderr, "inferspool: invalid or revoked API key; "+
				"run `inferspool key create` or `inferspool login <email>`")
		} else {
			fmt.Fprintln(os.Stderr, "inferspool:", err)
		}
		os.Exit(1)
	}
	os.Exit(code)
}

func usage() {
	fmt.Print(`inferspool — submit AI jobs to your home GPU queue

Usage:
  inferspool login <email>             sign in and configure this CLI
  inferspool logout                    remove the local account and API key
  inferspool whoami                    show the signed-in account
  inferspool key create|list|revoke    manage CLI API keys
  inferspool password                  change your account password
  inferspool admin user|worker         administer invited users and GPU workers
  inferspool submit <type> [text]      submit one job (types: image video tts llm)
  inferspool list                      list your recent jobs
  inferspool get    <id>               show one job
  inferspool cancel <id>               cancel a job
  inferspool rerun  <id>               run a completed or failed job again
  inferspool delete <id>               delete a finished job and its files
  inferspool status                    show which GPU services are online
  inferspool config set-key <key>      use an existing API key
  inferspool update                    install the latest verified release

Advanced automation:
  inferspool batch <type> <file>       submit one job per line
  inferspool watch <id>                follow an existing job
  inferspool webhook create|list|delete manage completion webhooks

Flags:
  -w, --wait          block until the job finishes (exit 1 if it failed)
  -q, --quiet         no progress line
  -j, --json          raw JSON output
  -n, --limit <n>     how many jobs to list (default 20)
      --status <s>    filter by status
      --type <t>      filter history by task type
      --search <text> search prompt/text
      --before <time> created before RFC3339 time
      --after <time>  created after RFC3339 time
      --filter-tag <t> filter history by tag
      --cursor <token> continue a paginated list
      --voice <name>  voice for text-to-speech (tts)
      --temperature <n> LLM sampling temperature (0-2)
      --max-tokens <n>  LLM output token limit
      --size <WxH>      image/video output size
      --steps <n>       image/video inference steps
      --seconds <n>     generated video duration
      --fps <n>         generated video frame rate
      --speed <n>       text-to-speech speed (0.25-4)
      --format <name>   text-to-speech output format
      --direct         deliver file results directly from a LAN worker
      --image <src>   attach an image to an llm task (repeatable; file or HTTPS URL)
      --stdin         read the prompt from stdin
      --timeout <s>   give up waiting after N seconds
      --tag <name>    resubmit an identical batch file as a new batch
      --key <name>    idempotency key for safe retries

Experimental:
      --experimental-json <json>  fields advertised by the current Worker only

Examples:
  inferspool login user@example.com
  inferspool submit llm "explain leases" --wait
  inferspool submit image "a cat riding a bicycle" -w
  inferspool submit image "a cat riding a bicycle" --direct --wait
  echo "read this aloud" | inferspool submit tts --stdin
  inferspool batch llm prompts.txt --wait
  inferspool status
`)
}

// -- flag parsing -------------------------------------------------------------

// flags is a tiny parser: the stdlib FlagSet cannot mix positional arguments
// with flags in any order, which is what a CLI like this needs.
type flags struct {
	wait             bool
	quiet            bool
	jsonOut          bool
	stdin            bool
	direct           bool
	limit            int
	timeout          int
	status           string
	jobType          string
	search           string
	before           string
	after            string
	filterTag        string
	cursor           string
	experimentalJSON string
	voice            string
	temperature      string
	maxTokens        string
	size             string
	steps            string
	seconds          string
	fps              string
	speed            string
	format           string
	images           []string
	tag              string
	key              string
	rest             []string
}

func parseFlags(args []string) (flags, error) {
	f := flags{limit: 20}

	for i := 0; i < len(args); i++ {
		a := args[i]
		next := func() (string, error) {
			if i+1 >= len(args) {
				return "", fmt.Errorf("%s needs a value", a)
			}
			i++
			return args[i], nil
		}

		var err error
		switch a {
		case "-w", "--wait":
			f.wait = true
		case "-q", "--quiet":
			f.quiet = true
		case "-j", "--json":
			f.jsonOut = true
		case "--stdin":
			f.stdin = true
		case "--direct":
			f.direct = true
		case "-n", "--limit":
			var v string
			if v, err = next(); err == nil {
				_, err = fmt.Sscanf(v, "%d", &f.limit)
			}
		case "--timeout":
			var v string
			if v, err = next(); err == nil {
				_, err = fmt.Sscanf(v, "%d", &f.timeout)
			}
		case "--status":
			f.status, err = next()
		case "--type":
			f.jobType, err = next()
		case "--search":
			f.search, err = next()
		case "--before":
			f.before, err = next()
		case "--after":
			f.after, err = next()
		case "--filter-tag":
			f.filterTag, err = next()
		case "--cursor":
			f.cursor, err = next()
		case "--experimental-json":
			f.experimentalJSON, err = next()
		case "--voice":
			f.voice, err = next()
		case "--temperature":
			f.temperature, err = next()
		case "--max-tokens":
			f.maxTokens, err = next()
		case "--size":
			f.size, err = next()
		case "--steps":
			f.steps, err = next()
		case "--seconds":
			f.seconds, err = next()
		case "--fps":
			f.fps, err = next()
		case "--speed":
			f.speed, err = next()
		case "--format":
			f.format, err = next()
		case "--image":
			var image string
			if image, err = next(); err == nil {
				f.images = append(f.images, image)
			}
		case "--tag":
			f.tag, err = next()
		case "--key":
			f.key, err = next()
		default:
			// A bare "-" means stdin, not a flag.
			if a != "-" && strings.HasPrefix(a, "-") {
				return f, fmt.Errorf("unknown flag %q", a)
			}
			f.rest = append(f.rest, a)
		}
		if err != nil {
			return f, err
		}
	}
	return f, nil
}

var jobTypes = map[string]bool{
	"image": true, "video": true, "tts": true, "llm": true,
}

// promptField is the payload key each type expects.
func promptField(jobType string) string {
	if jobType == "tts" {
		return "text"
	}
	return "prompt"
}

// batchKey is deterministic, so re-running an interrupted batch file skips work
// already queued. Pass --tag to deliberately resubmit the same file.
func batchKey(jobType, line, tag string) string {
	sum := sha256.Sum256([]byte(tag + ":" + jobType + ":" + line))
	return "batch:" + hex.EncodeToString(sum[:16])
}

func mustJSON(v any) string {
	data, _ := json.MarshalIndent(v, "", "  ")
	return string(data)
}

func waitTimeout(f flags) time.Duration {
	if f.timeout > 0 {
		return time.Duration(f.timeout) * time.Second
	}
	return 0 // wait indefinitely
}
