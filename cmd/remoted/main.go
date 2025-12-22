package main

import (
	"context"
	"crypto/sha1"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/godbus/dbus/v5"
	"nhooyr.io/websocket"
)

const (
	defaultBindAddress = "127.0.0.1"
	defaultPort        = 8080
	defaultVersion     = "0.0.1"
)

var (
	startedAt = time.Now()
)

var (
	lastPlayerMu sync.RWMutex
	lastPlayer   string
)

var (
	artCacheDir string
)

var globalHub *wsHub

//go:embed web/*
var webFS embed.FS

type Config struct {
	BindAddr     string
	Port         int
	Token        string
	Version      string
	ArtCache     string
	PrintVersion bool
}

type healthResponse struct {
	Status        string `json:"status"`
	Version       string `json:"version"`
	Host          string `json:"host"`
	Uptime        string `json:"uptime"`
	Started       string `json:"started"`
	Now           string `json:"now"`
	RequiresToken bool   `json:"requires_token"`
}

func main() {
	cfg := parseConfig()
	if cfg.PrintVersion {
		fmt.Printf("remoted %s\n", cfg.Version)
		return
	}
	artCacheDir = cfg.ArtCache
	if err := os.MkdirAll(artCacheDir, 0o755); err != nil {
		log.Fatalf("failed to create art cache dir: %v", err)
	}

	hub := newWSHub()
	globalHub = hub

	mux := http.NewServeMux()
	staticFS, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatalf("failed to init static fs: %v", err)
	}
	fileServer := http.FileServer(http.FS(staticFS))

	mux.HandleFunc("/healthz", healthHandler(cfg))
	mux.Handle("/players", requireToken(cfg.Token, http.HandlerFunc(playersHandler)))
	mux.Handle("/player/status", requireToken(cfg.Token, http.HandlerFunc(playerStatusHandler)))
	mux.Handle("/nowplaying", requireToken(cfg.Token, http.HandlerFunc(nowPlayingHandler)))
	mux.Handle("/player/playpause", requireToken(cfg.Token, http.HandlerFunc(playPauseHandler)))
	mux.Handle("/player/next", requireToken(cfg.Token, http.HandlerFunc(nextHandler)))
	mux.Handle("/player/prev", requireToken(cfg.Token, http.HandlerFunc(previousHandler)))
	mux.Handle("/player/seek", requireToken(cfg.Token, http.HandlerFunc(seekHandler)))
	mux.Handle("/volume", requireToken(cfg.Token, http.HandlerFunc(volumeHandler)))
	mux.Handle("/art/", requireToken(cfg.Token, http.HandlerFunc(artHandler)))
	mux.Handle("/ws", requireToken(cfg.Token, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wsHandler(hub, w, r)
	})))
	mux.Handle("/static/", http.StripPrefix("/static/", fileServer))
	mux.Handle("/ui", http.HandlerFunc(uiHandler))
	mux.Handle("/", http.HandlerFunc(uiHandler))

	srv := &http.Server{
		Addr:    net.JoinHostPort(cfg.BindAddr, strconv.Itoa(cfg.Port)),
		Handler: loggingMiddleware(mux),
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go hub.run(ctx)
	go startSignalListener(ctx, hub)

	go func() {
		log.Printf("remoted %s listening on %s:%d (token set: %t)", cfg.Version, cfg.BindAddr, cfg.Port, cfg.Token != "")
		log.Printf("web UI: http://%s:%d/ui", cfg.BindAddr, cfg.Port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server error: %v", err)
		}
	}()

	<-ctx.Done()
	stop()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("graceful shutdown failed: %v", err)
	} else {
		log.Printf("server stopped")
	}
}

func parseConfig() Config {
	defaultBind := getenvDefault("REMOTED_BIND", defaultBindAddress)
	defaultPort := getenvInt("REMOTED_PORT", defaultPort)
	defaultToken := os.Getenv("REMOTED_TOKEN")
	envVersion := getenvDefault("REMOTED_VERSION", defaultVersion)
	defaultArt := getenvDefault("REMOTED_ART_CACHE", defaultArtCacheDir())

	var cfg Config
	flag.StringVar(&cfg.BindAddr, "bind", defaultBind, "bind address (default from REMOTED_BIND)")
	flag.IntVar(&cfg.Port, "port", defaultPort, "port to listen on (default from REMOTED_PORT)")
	flag.StringVar(&cfg.Token, "token", defaultToken, "bearer token for API/UI (default from REMOTED_TOKEN)")
	flag.StringVar(&cfg.Version, "version", envVersion, "version string to report (default from REMOTED_VERSION)")
	flag.StringVar(&cfg.ArtCache, "art-cache", defaultArt, "artwork cache directory (default from REMOTED_ART_CACHE)")
	flag.BoolVar(&cfg.PrintVersion, "v", false, "print version and exit")

	flag.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "Usage: remoted [options]\n\n")
		flag.PrintDefaults()
	}
	flag.Parse()

	if cfg.Version == "" {
		cfg.Version = defaultVersion
	}
	return cfg
}

func healthHandler(cfg Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		host, _ := os.Hostname()
		resp := healthResponse{
			Status:        "ok",
			Version:       cfg.Version,
			Host:          host,
			Uptime:        time.Since(startedAt).Truncate(time.Millisecond).String(),
			Started:       startedAt.UTC().Format(time.RFC3339),
			Now:           time.Now().UTC().Format(time.RFC3339),
			RequiresToken: cfg.Token != "",
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start).String())
	})
}

func getenvDefault(key, fallback string) string {
	val := os.Getenv(key)
	if val == "" {
		return fallback
	}
	return val
}

func getenvInt(key string, fallback int) int {
	val := os.Getenv(key)
	if val == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(val)
	if err != nil {
		return fallback
	}
	return parsed
}

func writeJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

type playerInfo struct {
	BusName        string `json:"bus_name"`
	Identity       string `json:"identity"`
	PlaybackStatus string `json:"playback_status"`
	CanControl     bool   `json:"can_control"`
	IsActive       bool   `json:"is_active"`
	PositionMillis int64  `json:"position_millis,omitempty"`
	LengthMillis   int64  `json:"length_millis,omitempty"`
	TrackID        string `json:"track_id,omitempty"`
	Title          string `json:"title,omitempty"`
	Artist         string `json:"artist,omitempty"`
	Album          string `json:"album,omitempty"`
	URL            string `json:"url,omitempty"`
	ArtURL         string `json:"art_url,omitempty"`
	ArtURLProxy    string `json:"art_url_proxy,omitempty"`
}

type wsClient struct {
	conn   *websocket.Conn
	player string
	mu     sync.Mutex // serialize writes per client
}

type wsHub struct {
	mu      sync.RWMutex
	clients map[*wsClient]struct{}
	notify  chan struct{}
}

func newWSHub() *wsHub {
	return &wsHub{
		clients: make(map[*wsClient]struct{}),
		notify:  make(chan struct{}, 1),
	}
}

func (h *wsHub) addClient(c *websocket.Conn, player string) *wsClient {
	client := &wsClient{conn: c, player: player}
	h.mu.Lock()
	h.clients[client] = struct{}{}
	h.mu.Unlock()
	h.requestBroadcast()
	return client
}

func (h *wsHub) removeClient(client *wsClient) {
	h.mu.Lock()
	delete(h.clients, client)
	h.mu.Unlock()
	client.conn.Close(websocket.StatusNormalClosure, "bye")
}

func (h *wsHub) requestBroadcast() {
	select {
	case h.notify <- struct{}{}:
	default:
	}
}

func (h *wsHub) run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-h.notify:
			// Coalesce multiple notifications.
		Drain:
			for {
				select {
				case <-h.notify:
					continue
				default:
					break Drain
				}
			}
			h.broadcast(context.Background())
		}
	}
}

func (h *wsHub) broadcast(ctx context.Context) {
	h.mu.RLock()
	clients := make([]*wsClient, 0, len(h.clients))
	for c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.RUnlock()

	for _, c := range clients {
		if err := h.sendNowPlaying(ctx, c); err != nil {
			log.Printf("ws broadcast failed: %v", err)
		}
	}
}

func (h *wsHub) sendNowPlaying(ctx context.Context, client *wsClient) error {
	pctx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
	defer cancel()
	info, err := pickPlayer(pctx, client.player)
	if err != nil {
		return h.write(client, map[string]string{"error": err.Error()})
	}
	return h.write(client, info)
}

func (h *wsHub) write(client *wsClient, payload interface{}) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := client.conn.Write(ctx, websocket.MessageText, data); err != nil {
		return err
	}
	return nil
}

// startSignalListener listens for MPRIS changes and triggers broadcasts to connected WebSocket clients.
func startSignalListener(ctx context.Context, hub *wsHub) {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		log.Printf("ws signal listener: session bus connect failed: %v", err)
		return
	}

	propsMatch := "type='signal',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged',path_namespace='/org/mpris/MediaPlayer2'"
	nameMatch := "type='signal',interface='org.freedesktop.DBus',member='NameOwnerChanged'"
	_ = conn.BusObject().CallWithContext(ctx, "org.freedesktop.DBus.AddMatch", 0, propsMatch)
	_ = conn.BusObject().CallWithContext(ctx, "org.freedesktop.DBus.AddMatch", 0, nameMatch)

	sigCh := make(chan *dbus.Signal, 32)
	conn.Signal(sigCh)

	for {
		select {
		case <-ctx.Done():
			conn.RemoveSignal(sigCh)
			conn.Close()
			return
		case sig, ok := <-sigCh:
			if !ok || sig == nil {
				return
			}
			if strings.HasPrefix(string(sig.Path), "/org/mpris/MediaPlayer2") {
				hub.requestBroadcast()
				continue
			}
			if len(sig.Body) >= 1 {
				if name, ok := sig.Body[0].(string); ok && strings.HasPrefix(name, "org.mpris.MediaPlayer2.") {
					hub.requestBroadcast()
				}
			}
		}
	}
}

func playersHandler(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	players, err := listPlayers(ctx)
	if err != nil {
		http.Error(w, fmt.Sprintf("list players: %v", err), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, players)
}

func playerStatusHandler(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	target := r.URL.Query().Get("player")
	player, err := pickPlayer(ctx, target)
	if err != nil {
		http.Error(w, fmt.Sprintf("select player: %v", err), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, player)
}

// nowPlayingHandler is a convenience alias for playerStatus without needing a query param.
func nowPlayingHandler(w http.ResponseWriter, r *http.Request) {
	playerStatusHandler(w, r)
}

// wsHandler streams now-playing updates over WebSocket. Optionally accepts ?player= for a fixed player,
// or empty to auto-select. Updates are pushed from the server when changes are detected.
func wsHandler(hub *wsHub, w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		log.Printf("ws accept failed: %v", err)
		return
	}

	player := r.URL.Query().Get("player")
	client := hub.addClient(c, player)
	defer hub.removeClient(client)

	if err := hub.sendNowPlaying(ctx, client); err != nil {
		log.Printf("ws initial send failed: %v", err)
		return
	}

	for {
		// Drain incoming messages to detect disconnects; we don't expect payloads.
		_, _, err := c.Read(ctx)
		if err != nil {
			return
		}
	}
}

func playPauseHandler(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	target := r.URL.Query().Get("player")
	info, err := pickPlayer(ctx, target)
	if err != nil {
		http.Error(w, fmt.Sprintf("select player: %v", err), http.StatusBadRequest)
		return
	}

	method := "org.mpris.MediaPlayer2.Player.Play"
	action := "play"
	if strings.EqualFold(info.PlaybackStatus, "Playing") {
		method = "org.mpris.MediaPlayer2.Player.Pause"
		action = "pause"
	}

	if err := callPlayerMethod(ctx, info.BusName, method); err != nil {
		// Fallback to PlayPause for odd players that only implement the toggle.
		if err2 := callPlayerMethod(ctx, info.BusName, "org.mpris.MediaPlayer2.Player.PlayPause"); err2 != nil {
			http.Error(w, fmt.Sprintf("call %s (fallback PlayPause also failed): %v / %v", method, err, err2), http.StatusInternalServerError)
			return
		}
		action = "toggle"
		method = "org.mpris.MediaPlayer2.Player.PlayPause"
	}

	setLastPlayer(info.BusName)
	if globalHub != nil {
		globalHub.requestBroadcast()
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"player": info.Identity,
		"action": action,
		"status": "ok",
	})
}

func nextHandler(w http.ResponseWriter, r *http.Request) {
	controlHandler(w, r, "org.mpris.MediaPlayer2.Player.Next")
}

func previousHandler(w http.ResponseWriter, r *http.Request) {
	controlHandler(w, r, "org.mpris.MediaPlayer2.Player.Previous")
}

func controlHandler(w http.ResponseWriter, r *http.Request, method string) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	target := r.URL.Query().Get("player")
	info, err := pickPlayer(ctx, target)
	if err != nil {
		http.Error(w, fmt.Sprintf("select player: %v", err), http.StatusBadRequest)
		return
	}

	if err := callPlayerMethod(ctx, info.BusName, method); err != nil {
		http.Error(w, fmt.Sprintf("call %s: %v", method, err), http.StatusInternalServerError)
		return
	}

	setLastPlayer(info.BusName)
	if globalHub != nil {
		globalHub.requestBroadcast()
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"player": info.Identity,
		"action": method,
		"status": "ok",
	})
}

type seekRequest struct {
	DeltaMillis  *int64 `json:"delta_ms,omitempty"`
	TargetMillis *int64 `json:"target_ms,omitempty"`
}

func seekHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req seekRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	if req.DeltaMillis == nil && req.TargetMillis == nil {
		http.Error(w, "delta_ms or target_ms required", http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	target := r.URL.Query().Get("player")
	info, err := pickPlayer(ctx, target)
	if err != nil {
		http.Error(w, fmt.Sprintf("select player: %v", err), http.StatusBadRequest)
		return
	}

	switch {
	case req.TargetMillis != nil:
		if err := setPlayerPosition(ctx, info.BusName, info.TrackID, *req.TargetMillis); err != nil {
			// Fallback to relative seek if track ID missing or SetPosition not supported.
			if req.DeltaMillis == nil {
				http.Error(w, fmt.Sprintf("seek absolute: %v", err), http.StatusInternalServerError)
				return
			}
			if err := seekPlayer(ctx, info.BusName, *req.DeltaMillis); err != nil {
				http.Error(w, fmt.Sprintf("seek absolute fallback: %v", err), http.StatusInternalServerError)
				return
			}
		}
	case req.DeltaMillis != nil:
		if err := seekPlayer(ctx, info.BusName, *req.DeltaMillis); err != nil {
			http.Error(w, fmt.Sprintf("seek: %v", err), http.StatusInternalServerError)
			return
		}
	}

	setLastPlayer(info.BusName)
	if globalHub != nil {
		globalHub.requestBroadcast()
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"player": info.Identity,
		"action": "seek",
		"delta":  req.DeltaMillis,
		"target": req.TargetMillis,
		"status": "ok",
	})
}

func callPlayerMethod(ctx context.Context, busName, method string) error {
	conn, err := dbus.SessionBus()
	if err != nil {
		return fmt.Errorf("session bus: %w", err)
	}
	defer conn.Close()

	obj := conn.Object(busName, "/org/mpris/MediaPlayer2")
	call := obj.CallWithContext(ctx, method, 0)
	if call.Err != nil {
		return call.Err
	}
	return nil
}

func seekPlayer(ctx context.Context, busName string, deltaMillis int64) error {
	conn, err := dbus.SessionBus()
	if err != nil {
		return fmt.Errorf("session bus: %w", err)
	}
	defer conn.Close()

	obj := conn.Object(busName, "/org/mpris/MediaPlayer2")
	offsetMicros := deltaMillis * 1000
	call := obj.CallWithContext(ctx, "org.mpris.MediaPlayer2.Player.Seek", 0, offsetMicros)
	if call.Err != nil {
		return call.Err
	}
	return nil
}

func setPlayerPosition(ctx context.Context, busName, trackID string, targetMillis int64) error {
	if trackID == "" {
		return fmt.Errorf("track ID is required for absolute seek")
	}
	conn, err := dbus.SessionBus()
	if err != nil {
		return fmt.Errorf("session bus: %w", err)
	}
	defer conn.Close()

	obj := conn.Object(busName, "/org/mpris/MediaPlayer2")
	call := obj.CallWithContext(ctx, "org.mpris.MediaPlayer2.Player.SetPosition", 0, dbus.ObjectPath(trackID), targetMillis*1000)
	if call.Err != nil {
		return call.Err
	}
	return nil
}

func listPlayers(ctx context.Context) ([]playerInfo, error) {
	conn, err := dbus.SessionBus()
	if err != nil {
		return nil, fmt.Errorf("session bus: %w", err)
	}
	defer conn.Close()

	names, err := listNames(ctx, conn)
	if err != nil {
		return nil, fmt.Errorf("list names: %w", err)
	}

	var players []playerInfo
	for _, name := range names {
		if !strings.HasPrefix(name, "org.mpris.MediaPlayer2.") {
			continue
		}
		info, err := fetchPlayerInfo(ctx, conn, name)
		if err != nil {
			log.Printf("warn: skipping player %s: %v", name, err)
			continue
		}
		players = append(players, info)
	}
	players = markActive(players)
	return players, nil
}

func pickPlayer(ctx context.Context, preferred string) (playerInfo, error) {
	players, err := listPlayers(ctx)
	if err != nil {
		return playerInfo{}, err
	}
	if len(players) == 0 {
		return playerInfo{}, fmt.Errorf("no players found")
	}

	recordIfPlaying := func(p playerInfo) playerInfo {
		if strings.EqualFold(p.PlaybackStatus, "Playing") {
			setLastPlayer(p.BusName)
		}
		return p
	}
	if preferred != "" {
		for _, p := range players {
			if p.BusName == preferred || p.Identity == preferred {
				return recordIfPlaying(p), nil
			}
		}
		return playerInfo{}, fmt.Errorf("player %q not found", preferred)
	}
	last := getLastPlayer()
	playing := func(p playerInfo) bool {
		return strings.EqualFold(p.PlaybackStatus, "Playing")
	}

	// 1) If last player is still present and playing, stick with it.
	if last != "" {
		for _, p := range players {
			if (p.BusName == last || p.Identity == last) && playing(p) {
				return recordIfPlaying(p), nil
			}
		}
	}
	// 2) Otherwise, choose any playing player.
	for _, p := range players {
		if playing(p) {
			return recordIfPlaying(p), nil
		}
	}
	// 3) If none playing, keep last if still present.
	if last != "" {
		for _, p := range players {
			if p.BusName == last || p.Identity == last {
				return p, nil
			}
		}
	}
	// 4) Fallback to first paused, else first.
	for _, p := range players {
		if strings.EqualFold(p.PlaybackStatus, "Paused") {
			return p, nil
		}
	}
	return players[0], nil
}

func fetchPlayerInfo(ctx context.Context, conn *dbus.Conn, busName string) (playerInfo, error) {
	obj := conn.Object(busName, "/org/mpris/MediaPlayer2")

	identityVariant, err := obj.GetProperty("org.mpris.MediaPlayer2.Identity")
	if err != nil {
		return playerInfo{}, fmt.Errorf("identity: %w", err)
	}
	playbackVariant, err := obj.GetProperty("org.mpris.MediaPlayer2.Player.PlaybackStatus")
	if err != nil {
		return playerInfo{}, fmt.Errorf("playback: %w", err)
	}
	canControlVariant, err := obj.GetProperty("org.mpris.MediaPlayer2.Player.CanControl")
	if err != nil {
		return playerInfo{}, fmt.Errorf("canControl: %w", err)
	}

	info := playerInfo{
		BusName:        busName,
		Identity:       asString(identityVariant),
		PlaybackStatus: asString(playbackVariant),
		CanControl:     asBool(canControlVariant),
	}

	metaVariant, err := obj.GetProperty("org.mpris.MediaPlayer2.Player.Metadata")
	if err == nil {
		populateMetadata(&info, metaVariant)
	}

	positionVariant, err := obj.GetProperty("org.mpris.MediaPlayer2.Player.Position")
	if err == nil {
		info.PositionMillis = asInt64(positionVariant) / 1000
	}

	return info, nil
}

func markActive(players []playerInfo) []playerInfo {
	last := getLastPlayer()
	playing := func(p playerInfo) bool {
		return strings.EqualFold(p.PlaybackStatus, "Playing")
	}
	// align with pickPlayer ordering
	if last != "" {
		for i, p := range players {
			if (p.BusName == last || p.Identity == last) && playing(p) {
				players[i].IsActive = true
				return players
			}
		}
	}
	for i, p := range players {
		if playing(p) {
			players[i].IsActive = true
			return players
		}
	}
	if last != "" {
		for i, p := range players {
			if p.BusName == last || p.Identity == last {
				players[i].IsActive = true
				return players
			}
		}
	}
	for i, p := range players {
		if strings.EqualFold(p.PlaybackStatus, "Paused") {
			players[i].IsActive = true
			return players
		}
	}
	if len(players) > 0 {
		players[0].IsActive = true
	}
	return players
}

func listNames(ctx context.Context, conn *dbus.Conn) ([]string, error) {
	obj := conn.Object("org.freedesktop.DBus", "/org/freedesktop/DBus")
	var names []string
	call := obj.CallWithContext(ctx, "org.freedesktop.DBus.ListNames", 0)
	if call.Err != nil {
		return nil, call.Err
	}
	if err := call.Store(&names); err != nil {
		return nil, err
	}
	return names, nil
}

func asString(v dbus.Variant) string {
	if s, ok := v.Value().(string); ok {
		return s
	}
	if p, ok := v.Value().(dbus.ObjectPath); ok {
		return string(p)
	}
	return ""
}

func asBool(v dbus.Variant) bool {
	if b, ok := v.Value().(bool); ok {
		return b
	}
	return false
}

func asInt64(v dbus.Variant) int64 {
	switch val := v.Value().(type) {
	case int64:
		return val
	case int32:
		return int64(val)
	case uint64:
		return int64(val)
	case uint32:
		return int64(val)
	default:
		return 0
	}
}

func populateMetadata(info *playerInfo, meta dbus.Variant) {
	raw, ok := meta.Value().(map[string]dbus.Variant)
	if !ok {
		return
	}
	if title, ok := raw["xesam:title"]; ok {
		info.Title = asString(title)
	}
	if album, ok := raw["xesam:album"]; ok {
		info.Album = asString(album)
	}
	if art, ok := raw["mpris:artUrl"]; ok {
		info.ArtURL = asString(art)
		if proxied := proxyArtURL(info.ArtURL); proxied != "" {
			info.ArtURLProxy = proxied
		}
	}
	if artist, ok := raw["xesam:artist"]; ok {
		info.Artist = firstString(artist)
	}
	if url, ok := raw["xesam:url"]; ok {
		info.URL = asString(url)
	}
	if trackID, ok := raw["mpris:trackid"]; ok {
		info.TrackID = asString(trackID)
	}
	if length, ok := raw["mpris:length"]; ok {
		info.LengthMillis = asInt64(length) / 1000
	}
}

func firstString(v dbus.Variant) string {
	switch val := v.Value().(type) {
	case []string:
		if len(val) > 0 {
			return val[0]
		}
	case []interface{}:
		for _, item := range val {
			if s, ok := item.(string); ok {
				return s
			}
		}
	}
	return ""
}

type volumeResponse struct {
	Backend string  `json:"backend"`
	Volume  float64 `json:"volume"`
	Muted   bool    `json:"muted"`
}

type setVolumeRequest struct {
	Absolute *float64 `json:"absolute,omitempty"`
	Delta    *float64 `json:"delta,omitempty"`
	Mute     *bool    `json:"mute,omitempty"`
}

func volumeHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		resp, err := getVolume(r.Context())
		if err != nil {
			http.Error(w, fmt.Sprintf("get volume: %v", err), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, resp)
	case http.MethodPost:
		var req setVolumeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid JSON", http.StatusBadRequest)
			return
		}
		if req.Absolute == nil && req.Delta == nil && req.Mute == nil {
			http.Error(w, "provide absolute, delta, or mute", http.StatusBadRequest)
			return
		}
		resp, err := setVolume(r.Context(), req)
		if err != nil {
			http.Error(w, fmt.Sprintf("set volume: %v", err), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, resp)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func getVolume(ctx context.Context) (volumeResponse, error) {
	if resp, err := getVolumeWPCTL(ctx); err == nil {
		return resp, nil
	}
	return getVolumePACTL(ctx)
}

func setVolume(ctx context.Context, req setVolumeRequest) (volumeResponse, error) {
	if resp, err := setVolumeWPCTL(ctx, req); err == nil {
		return resp, nil
	}
	return setVolumePACTL(ctx, req)
}

func getVolumeWPCTL(ctx context.Context) (volumeResponse, error) {
	out, err := runCmd(ctx, "wpctl", "get-volume", "@DEFAULT_AUDIO_SINK@")
	if err != nil {
		return volumeResponse{}, err
	}
	vol, muted, err := parseWPCTLVolume(out)
	if err != nil {
		return volumeResponse{}, err
	}
	return volumeResponse{Backend: "wpctl", Volume: vol, Muted: muted}, nil
}

func setVolumeWPCTL(ctx context.Context, req setVolumeRequest) (volumeResponse, error) {
	current, err := getVolumeWPCTL(ctx)
	if err != nil {
		return volumeResponse{}, err
	}

	if req.Mute != nil {
		val := "0"
		if *req.Mute {
			val = "1"
		}
		if _, err := runCmd(ctx, "wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", val); err != nil {
			return volumeResponse{}, err
		}
		current.Muted = *req.Mute
	}

	newVolume := current.Volume
	if req.Absolute != nil {
		newVolume = *req.Absolute
	} else if req.Delta != nil {
		newVolume = current.Volume + *req.Delta
	}
	newVolume = clamp(newVolume, 0.0, 1.5)

	if req.Absolute != nil || req.Delta != nil {
		if _, err := runCmd(ctx, "wpctl", "set-volume", "--limit", "1.5", "@DEFAULT_AUDIO_SINK@", fmt.Sprintf("%.3f", newVolume)); err != nil {
			return volumeResponse{}, err
		}
		current.Volume = newVolume
	}

	return current, nil
}

func getVolumePACTL(ctx context.Context) (volumeResponse, error) {
	out, err := runCmd(ctx, "pactl", "get-sink-volume", "@DEFAULT_SINK@")
	if err != nil {
		return volumeResponse{}, err
	}
	mutedOut, _ := runCmd(ctx, "pactl", "get-sink-mute", "@DEFAULT_SINK@")

	vol, err := parsePACTLVolume(out)
	if err != nil {
		return volumeResponse{}, err
	}
	muted := strings.Contains(strings.ToLower(mutedOut), "yes")

	return volumeResponse{Backend: "pactl", Volume: vol, Muted: muted}, nil
}

func setVolumePACTL(ctx context.Context, req setVolumeRequest) (volumeResponse, error) {
	current, err := getVolumePACTL(ctx)
	if err != nil {
		return volumeResponse{}, err
	}

	if req.Mute != nil {
		val := "0"
		if *req.Mute {
			val = "1"
		}
		if _, err := runCmd(ctx, "pactl", "set-sink-mute", "@DEFAULT_SINK@", val); err != nil {
			return volumeResponse{}, err
		}
		current.Muted = *req.Mute
	}

	newVolume := current.Volume
	if req.Absolute != nil {
		newVolume = *req.Absolute
	} else if req.Delta != nil {
		newVolume = current.Volume + *req.Delta
	}
	newVolume = clamp(newVolume, 0.0, 1.5)

	if req.Absolute != nil || req.Delta != nil {
		// pactl expects percentage; convert factor (1.0 = 100%).
		percent := int(newVolume * 100)
		if _, err := runCmd(ctx, "pactl", "set-sink-volume", "@DEFAULT_SINK@", fmt.Sprintf("%d%%", percent)); err != nil {
			return volumeResponse{}, err
		}
		current.Volume = newVolume
	}

	return current, nil
}

func parseWPCTLVolume(out string) (float64, bool, error) {
	// Example: "Volume: 0.38 [MUTED]" or "Volume: 1.04"
	fields := strings.Fields(out)
	if len(fields) < 2 {
		return 0, false, fmt.Errorf("unexpected output: %q", out)
	}
	val, err := strconv.ParseFloat(fields[1], 64)
	if err != nil {
		return 0, false, fmt.Errorf("parse volume: %w", err)
	}
	muted := strings.Contains(strings.ToUpper(out), "MUTED")
	return val, muted, nil
}

func parsePACTLVolume(out string) (float64, error) {
	// Example: "Volume: front-left: 65536 / 100% / 0.00 dB,   front-right: 65536 / 100% / 0.00 dB"
	idx := strings.Index(out, "/")
	if idx == -1 {
		return 0, fmt.Errorf("unexpected pactl output: %q", out)
	}
	rest := out[idx+1:]
	end := strings.Index(rest, "%")
	if end == -1 {
		return 0, fmt.Errorf("unexpected pactl output: %q", out)
	}
	percentStr := strings.TrimSpace(rest[:end])
	percent, err := strconv.Atoi(percentStr)
	if err != nil {
		return 0, fmt.Errorf("parse pactl percent: %w", err)
	}
	return float64(percent) / 100.0, nil
}

func clamp(val, min, max float64) float64 {
	if val < min {
		return min
	}
	if val > max {
		return max
	}
	return val
}

func runCmd(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%s %v: %v (%s)", name, args, err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}

func setLastPlayer(busName string) {
	lastPlayerMu.Lock()
	defer lastPlayerMu.Unlock()
	lastPlayer = busName
}

func getLastPlayer() string {
	lastPlayerMu.RLock()
	defer lastPlayerMu.RUnlock()
	return lastPlayer
}

func defaultArtCacheDir() string {
	if dir, err := os.UserCacheDir(); err == nil && dir != "" {
		return filepath.Join(dir, "umr", "art")
	}
	return filepath.Join(os.TempDir(), "umr", "art")
}

func proxyArtURL(artURL string) string {
	u, err := url.Parse(artURL)
	if err != nil {
		return ""
	}
	if u.Scheme != "file" {
		return ""
	}

	srcPath := filepath.Clean(u.Path)
	if !isPathAllowed(srcPath) {
		return ""
	}

	cacheName, err := cacheArt(srcPath)
	if err != nil {
		log.Printf("warn: cache art failed for %s: %v", srcPath, err)
		return ""
	}
	return "/art/" + cacheName
}

func cacheArt(srcPath string) (string, error) {
	stat, err := os.Stat(srcPath)
	if err != nil {
		return "", err
	}

	hash := sha1.New()
	_, _ = io.WriteString(hash, srcPath)
	_, _ = io.WriteString(hash, stat.ModTime().UTC().String())
	_, _ = io.WriteString(hash, fmt.Sprintf("%d", stat.Size()))
	sum := fmt.Sprintf("%x", hash.Sum(nil))

	ext := filepath.Ext(srcPath)
	if ext == "" {
		ext = ".img"
	}
	cacheName := sum + ext
	dest := filepath.Join(artCacheDir, cacheName)

	if dstInfo, err := os.Stat(dest); err == nil {
		if dstInfo.ModTime().After(stat.ModTime()) || dstInfo.Size() == stat.Size() {
			return cacheName, nil
		}
	}

	src, err := os.Open(srcPath)
	if err != nil {
		return "", err
	}
	defer src.Close()

	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return "", err
	}

	tmpDest := dest + ".tmp"
	dst, err := os.Create(tmpDest)
	if err != nil {
		return "", err
	}

	_, err = io.Copy(dst, src)
	closeErr := dst.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(tmpDest)
		return "", err
	}

	if err := os.Rename(tmpDest, dest); err != nil {
		return "", err
	}

	return cacheName, nil
}

func isPathAllowed(p string) bool {
	allowed := []string{"/tmp", "/var/tmp"}
	for _, prefix := range allowed {
		if strings.HasPrefix(p, prefix) {
			return true
		}
	}
	return false
}

func artHandler(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/art/")
	if id == "" {
		http.NotFound(w, r)
		return
	}
	name := filepath.Base(id)
	path := filepath.Join(artCacheDir, name)
	if !strings.HasPrefix(path, artCacheDir) {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return
	}
	if _, err := os.Stat(path); err != nil {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, path)
}

func uiHandler(w http.ResponseWriter, r *http.Request) {
	data, err := webFS.ReadFile("web/index.html")
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(data)
}

func requireToken(token string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if token == "" {
			next.ServeHTTP(w, r)
			return
		}

		presented := extractToken(r)
		if presented == token {
			next.ServeHTTP(w, r)
			return
		}

		http.Error(w, "unauthorized", http.StatusUnauthorized)
	})
}

func extractToken(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	if auth != "" {
		const bearer = "Bearer "
		if len(auth) > len(bearer) && auth[:len(bearer)] == bearer {
			return auth[len(bearer):]
		}
	}
	if token := r.Header.Get("X-Remote-Token"); token != "" {
		return token
	}
	if token := r.URL.Query().Get("token"); token != "" {
		return token
	}
	return ""
}
