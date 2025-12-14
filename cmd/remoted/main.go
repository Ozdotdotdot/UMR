package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

const (
	defaultBindAddress = "127.0.0.1"
	defaultPort        = 8080
	defaultVersion     = "0.0.1"
)

var (
	startedAt = time.Now()
)

type Config struct {
	BindAddr string
	Port     int
	Token    string
	Version  string
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
	cfg := loadConfig()

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", healthHandler(cfg))

	srv := &http.Server{
		Addr:    net.JoinHostPort(cfg.BindAddr, strconv.Itoa(cfg.Port)),
		Handler: loggingMiddleware(mux),
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Printf("remoted %s listening on %s:%d (token set: %t)", cfg.Version, cfg.BindAddr, cfg.Port, cfg.Token != "")
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

func loadConfig() Config {
	cfg := Config{
		BindAddr: getenvDefault("REMOTED_BIND", defaultBindAddress),
		Port:     getenvInt("REMOTED_PORT", defaultPort),
		Token:    os.Getenv("REMOTED_TOKEN"),
		Version:  getenvDefault("REMOTED_VERSION", defaultVersion),
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
	return ""
}
