package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error {
	*s = append(*s, v)
	return nil
}

type commonOptions struct {
	format  string
	jsonOut bool
	pretty  bool
	timeout string
	envFile string
}

type searchOptions struct {
	common                   commonOptions
	searchDepth              string
	chunksPerSource          int
	maxResults               int
	topic                    string
	timeRange                string
	startDate                string
	endDate                  string
	includeAnswer            string
	includeRawContent        string
	includeImages            bool
	includeImageDescriptions bool
	includeFavicon           bool
	includeDomains           stringList
	excludeDomains           stringList
	country                  string
	autoParameters           bool
	exactMatch               bool
}

type config struct {
	apiKey   string
	baseURL  string
	timeout  time.Duration
	skillDir string
}

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
		printHelp(stdout)
		return nil
	}

	switch args[0] {
	case "search":
		return runSearch(args[1:], stdout, stderr)
	default:
		printHelp(stderr)
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func runSearch(args []string, stdout, stderr io.Writer) error {
	flagArgs, query := splitFlagsAndQuery(args, valueFlags("format", "timeout", "env-file", "search-depth", "chunks-per-source", "max-results", "topic", "time-range", "start-date", "end-date", "include-answer", "include-raw-content", "include-domain", "exclude-domain", "country"))
	fs := flag.NewFlagSet("search", flag.ContinueOnError)
	fs.SetOutput(stderr)
	opts := searchOptions{searchDepth: "basic", maxResults: 5, topic: "general", includeAnswer: "false", includeRawContent: "false"}
	addCommonFlags(fs, &opts.common)
	fs.StringVar(&opts.searchDepth, "search-depth", opts.searchDepth, "search depth")
	fs.IntVar(&opts.chunksPerSource, "chunks-per-source", 0, "chunks per source")
	fs.IntVar(&opts.maxResults, "max-results", opts.maxResults, "maximum results")
	fs.StringVar(&opts.topic, "topic", opts.topic, "topic")
	fs.StringVar(&opts.timeRange, "time-range", "", "time range")
	fs.StringVar(&opts.startDate, "start-date", "", "start date")
	fs.StringVar(&opts.endDate, "end-date", "", "end date")
	fs.StringVar(&opts.includeAnswer, "include-answer", opts.includeAnswer, "false, true, basic, or advanced")
	fs.StringVar(&opts.includeRawContent, "include-raw-content", opts.includeRawContent, "false, true, markdown, or text")
	fs.BoolVar(&opts.includeImages, "include-images", false, "include images")
	fs.BoolVar(&opts.includeImageDescriptions, "include-image-descriptions", false, "include image descriptions")
	fs.BoolVar(&opts.includeFavicon, "include-favicon", false, "include favicon")
	fs.Var(&opts.includeDomains, "include-domain", "domain to include; repeatable")
	fs.Var(&opts.excludeDomains, "exclude-domain", "domain to exclude; repeatable")
	fs.StringVar(&opts.country, "country", "", "country")
	fs.BoolVar(&opts.autoParameters, "auto-parameters", false, "enable auto parameters")
	fs.BoolVar(&opts.exactMatch, "exact-match", false, "exact match")
	if err := fs.Parse(flagArgs); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if query == "" {
		return errors.New("missing query")
	}

	cfg, err := loadConfig(opts.common)
	if err != nil {
		return err
	}

	body := map[string]any{
		"query":        query,
		"search_depth": opts.searchDepth,
		"max_results":  opts.maxResults,
		"topic":        opts.topic,
	}
	if opts.chunksPerSource > 0 {
		body["chunks_per_source"] = opts.chunksPerSource
	}
	setIfNotEmpty(body, "time_range", opts.timeRange)
	setIfNotEmpty(body, "start_date", opts.startDate)
	setIfNotEmpty(body, "end_date", opts.endDate)
	setIfNotEmpty(body, "country", opts.country)
	if value, ok := parseBoolish(opts.includeAnswer); ok {
		body["include_answer"] = value
	} else if opts.includeAnswer != "" {
		body["include_answer"] = opts.includeAnswer
	}
	if value, ok := parseBoolish(opts.includeRawContent); ok {
		body["include_raw_content"] = value
	} else if opts.includeRawContent != "" {
		body["include_raw_content"] = opts.includeRawContent
	}
	if opts.includeImages {
		body["include_images"] = true
	}
	if opts.includeImageDescriptions {
		body["include_image_descriptions"] = true
	}
	if opts.includeFavicon {
		body["include_favicon"] = true
	}
	if len(opts.includeDomains) > 0 {
		body["include_domains"] = []string(opts.includeDomains)
	}
	if len(opts.excludeDomains) > 0 {
		body["exclude_domains"] = []string(opts.excludeDomains)
	}
	if opts.autoParameters {
		body["auto_parameters"] = true
	}
	if opts.exactMatch {
		body["exact_match"] = true
	}

	raw, err := postJSON(cfg, "/search", body)
	if err != nil {
		return err
	}
	return writeOutput(stdout, normalizedFormat(opts.common), raw, func(v any) string { return tavilySearchMarkdown(query, v) })
}

func addCommonFlags(fs *flag.FlagSet, opts *commonOptions) {
	fs.StringVar(&opts.format, "format", "markdown", "output format: markdown, json, pretty-json")
	fs.BoolVar(&opts.jsonOut, "json", false, "output raw JSON")
	fs.BoolVar(&opts.pretty, "pretty", false, "output pretty JSON")
	fs.StringVar(&opts.timeout, "timeout", "", "request timeout, for example 60s")
	fs.StringVar(&opts.envFile, "env-file", "", "path to .env file")
}

func printHelp(w io.Writer) {
	fmt.Fprint(w, `Usage:
  tavily-search search <query> [flags]

Common flags:
  --format <markdown|json|pretty-json>  Output format; default markdown
  --json                                Equivalent to --format json
  --pretty                              Equivalent to --format pretty-json
  --timeout <duration>                  Request timeout; default TAVILY_TIMEOUT or 60s
  --env-file <path>                     Read this .env file instead of the skill .env

Search flags:
  --search-depth <basic|advanced|fast|ultra-fast>
  --chunks-per-source <n>
  --max-results <n>
  --topic <general|news|finance>
  --time-range <day|week|month|year>
  --start-date <YYYY-MM-DD>
  --end-date <YYYY-MM-DD>
  --include-answer <false|true|basic|advanced>
  --include-raw-content <false|true|markdown|text>
  --include-images
  --include-image-descriptions
  --include-favicon
  --include-domain <domain>             Repeatable
  --exclude-domain <domain>             Repeatable
  --country <country>
  --auto-parameters
  --exact-match
`)
}

func valueFlags(names ...string) map[string]bool {
	m := map[string]bool{}
	for _, name := range names {
		m["--"+name] = true
	}
	return m
}

func splitFlagsAndQuery(args []string, valueFlag map[string]bool) ([]string, string) {
	var flags []string
	var query []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if strings.HasPrefix(arg, "--") {
			flags = append(flags, arg)
			name := arg
			if before, _, found := strings.Cut(arg, "="); found {
				name = before
			}
			if valueFlag[name] && !strings.Contains(arg, "=") && i+1 < len(args) {
				i++
				flags = append(flags, args[i])
			}
			continue
		}
		query = append(query, arg)
	}
	return flags, strings.TrimSpace(strings.Join(query, " "))
}

func normalizedFormat(opts commonOptions) string {
	if opts.jsonOut {
		return "json"
	}
	if opts.pretty {
		return "pretty-json"
	}
	if opts.format == "" {
		return "markdown"
	}
	return opts.format
}

func loadConfig(opts commonOptions) (config, error) {
	skillDir := detectSkillDir()
	envPath := opts.envFile
	if envPath == "" && skillDir != "" {
		envPath = filepath.Join(skillDir, ".env")
	}
	dotenv := map[string]string{}
	if envPath != "" {
		dotenv = readEnvFile(envPath)
	}

	apiKey := getSetting("TAVILY_API_KEY", dotenv)
	if apiKey == "" {
		return config{}, fmt.Errorf("missing TAVILY_API_KEY. Copy %s to %s and set TAVILY_API_KEY, or set TAVILY_API_KEY in the environment", filepath.Join(skillDir, ".env.example"), filepath.Join(skillDir, ".env"))
	}
	baseURL := getSetting("TAVILY_BASE_URL", dotenv)
	if baseURL == "" {
		baseURL = "https://api.tavily.com"
	}
	timeoutText := opts.timeout
	if timeoutText == "" {
		timeoutText = getSetting("TAVILY_TIMEOUT", dotenv)
	}
	if timeoutText == "" {
		timeoutText = "60s"
	}
	timeout, err := time.ParseDuration(timeoutText)
	if err != nil {
		return config{}, fmt.Errorf("invalid timeout %q", timeoutText)
	}
	return config{apiKey: apiKey, baseURL: strings.TrimRight(baseURL, "/"), timeout: timeout, skillDir: skillDir}, nil
}

func detectSkillDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "/workspace/mcp2skill/tavily-search"
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return "/workspace/mcp2skill/tavily-search"
	}
	return filepath.Dir(filepath.Dir(exe))
}

func readEnvFile(path string) map[string]string {
	values := map[string]string{}
	file, err := os.Open(path)
	if err != nil {
		return values
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		value = strings.Trim(value, `"'`)
		if key != "" {
			values[key] = value
		}
	}
	if err := scanner.Err(); err != nil {
		return values
	}
	return values
}

func getSetting(key string, dotenv map[string]string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return dotenv[key]
}

func postJSON(cfg config, path string, body map[string]any) ([]byte, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: cfg.timeout}
	req, err := http.NewRequest(http.MethodPost, cfg.baseURL+path, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+cfg.apiKey)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("Tavily API request failed with status %s: %s", resp.Status, strings.TrimSpace(string(raw)))
	}
	return raw, nil
}

func writeOutput(stdout io.Writer, format string, raw []byte, markdown func(any) string) error {
	switch format {
	case "json":
		_, err := stdout.Write(raw)
		if err == nil {
			_, err = fmt.Fprintln(stdout)
		}
		return err
	case "pretty-json":
		var buf bytes.Buffer
		if err := json.Indent(&buf, raw, "", "  "); err != nil {
			_, writeErr := stdout.Write(raw)
			return writeErr
		}
		_, err := fmt.Fprintln(stdout, buf.String())
		return err
	case "markdown":
		var parsed any
		if err := json.Unmarshal(raw, &parsed); err != nil {
			_, writeErr := fmt.Fprintln(stdout, string(raw))
			return writeErr
		}
		_, err := fmt.Fprint(stdout, markdown(parsed))
		return err
	default:
		return fmt.Errorf("unsupported format %q", format)
	}
}

func tavilySearchMarkdown(query string, v any) string {
	var b strings.Builder
	fmt.Fprintln(&b, "# Tavily Search Results")
	fmt.Fprintln(&b)
	fmt.Fprintf(&b, "Query: %s\n\n", query)
	m, _ := v.(map[string]any)
	answer := firstString(m, "answer")
	if answer != "" {
		fmt.Fprintln(&b, "## Answer")
		fmt.Fprintln(&b, answer)
		fmt.Fprintln(&b)
	}
	fmt.Fprintln(&b, "## Results")
	results := firstArray(m, "results")
	if len(results) == 0 {
		fmt.Fprintln(&b, "No results found.")
		return b.String()
	}
	for i, item := range results {
		rm, _ := item.(map[string]any)
		title := firstString(rm, "title")
		if title == "" {
			title = "Untitled"
		}
		fmt.Fprintf(&b, "### %d. %s\n", i+1, title)
		writeField(&b, "URL", firstString(rm, "url"))
		if score, ok := rm["score"]; ok {
			writeField(&b, "Score", stringify(score))
		}
		writeField(&b, "Favicon", firstString(rm, "favicon"))
		fmt.Fprintln(&b)
		content := firstString(rm, "content")
		if content != "" {
			fmt.Fprintln(&b, content)
			fmt.Fprintln(&b)
		}
		raw := firstString(rm, "raw_content")
		if raw != "" {
			fmt.Fprintln(&b, "<details>")
			fmt.Fprintln(&b, "<summary>Raw content</summary>")
			fmt.Fprintln(&b)
			fmt.Fprintln(&b, raw)
			fmt.Fprintln(&b)
			fmt.Fprintln(&b, "</details>")
			fmt.Fprintln(&b)
		}
	}
	return b.String()
}

func parseBoolish(value string) (bool, bool) {
	switch strings.ToLower(value) {
	case "true":
		return true, true
	case "false":
		return false, true
	default:
		return false, false
	}
}

func setIfNotEmpty(m map[string]any, key, value string) {
	if value != "" {
		m[key] = value
	}
}

func writeField(b *strings.Builder, name, value string) {
	if value != "" {
		fmt.Fprintf(b, "- %s: %s\n", name, value)
	}
}

func firstArray(m map[string]any, keys ...string) []any {
	for _, key := range keys {
		if arr, ok := m[key].([]any); ok {
			return arr
		}
	}
	return nil
}

func firstString(m map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := m[key]; ok {
			if s := stringify(value); s != "" {
				return s
			}
		}
	}
	return ""
}

func stringify(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	default:
		buf, err := json.Marshal(x)
		if err != nil {
			return fmt.Sprint(x)
		}
		return string(buf)
	}
}
