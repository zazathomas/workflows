package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/argoproj/argo-workflows/v4/runner/broker"
)

func main() {
	log.SetFlags(0)
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	if len(os.Args) < 2 {
		return errors.New("usage: argo-runner-broker serve | plugin | migrate | mint [ttl] | revoke RUNNER_ID")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	mode := os.Args[1]
	namespace, pool := os.Getenv("BROKER_NAMESPACE"), os.Getenv("BROKER_POOL")
	var token string
	if mode == "plugin" || mode == "serve" || mode == "mint" || mode == "revoke" {
		raw, err := os.ReadFile(os.Getenv("BROKER_PLUGIN_TOKEN_FILE"))
		if mode == "plugin" && os.Getenv("BROKER_PLUGIN_TOKEN_FILE") == "" {
			token = strings.TrimSpace(os.Getenv("BROKER_PLUGIN_TOKEN"))
		} else if err != nil {
			return errors.New("could not read BROKER_PLUGIN_TOKEN_FILE")
		} else {
			token = strings.TrimSpace(string(raw))
		}
	}
	if mode == "plugin" {
		p, err := broker.NewPlugin(os.Getenv("BROKER_URL"), token, "/var/run/argo/token", namespace, pool, os.Getenv("BROKER_CA_PEM"))
		if err != nil {
			return err
		}
		return serve(ctx, "127.0.0.1:10176", p, "", "")
	}
	if mode != "serve" && mode != "migrate" && mode != "mint" && mode != "revoke" {
		return errors.New("unknown broker command")
	}
	dsn := os.Getenv("BROKER_DATABASE_URL")
	if dsn == "" {
		return errors.New("BROKER_DATABASE_URL is required")
	}
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return errors.New("invalid broker database configuration")
	}
	defer func() { _ = db.Close() }()
	db.SetMaxOpenConns(16)
	db.SetMaxIdleConns(8)
	db.SetConnMaxLifetime(30 * time.Minute)
	startup, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if err = db.PingContext(startup); err != nil {
		return errors.New("could not connect to broker database")
	}
	if mode == "migrate" {
		if err = broker.Migrate(startup, db); err != nil {
			return errors.New("broker schema migration failed")
		}
		return nil
	}
	limit := 8
	if value := os.Getenv("BROKER_CONCURRENCY"); value != "" {
		limit, err = strconv.Atoi(value)
		if err != nil {
			return errors.New("invalid BROKER_CONCURRENCY")
		}
	}
	b, err := broker.NewServer(db, broker.Config{Namespace: namespace, Pool: pool, PluginToken: token, Concurrency: limit})
	if err != nil {
		return err
	}
	if mode == "mint" {
		ttl := 15 * time.Minute
		if len(os.Args) > 2 {
			ttl, err = time.ParseDuration(os.Args[2])
			if err != nil {
				return errors.New("invalid join token TTL")
			}
		}
		token, err := b.Mint(startup, ttl)
		if err != nil {
			return errors.New("could not issue broker join token")
		}
		fmt.Println(token)
		return nil
	}
	if mode == "revoke" {
		if len(os.Args) != 3 {
			return errors.New("revoke requires a runner ID")
		}
		if err = b.Revoke(startup, os.Args[2]); err != nil {
			return errors.New("could not revoke runner")
		}
		return nil
	}
	cert, key := os.Getenv("BROKER_TLS_CERT"), os.Getenv("BROKER_TLS_KEY")
	if cert == "" || key == "" {
		return errors.New("BROKER_TLS_CERT and BROKER_TLS_KEY are required")
	}
	if err := b.Maintain(startup); err != nil {
		return errors.New("broker schema is not usable; run migrate first")
	}
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				maintenance, done := context.WithTimeout(ctx, 10*time.Second)
				if err := b.Maintain(maintenance); err != nil {
					log.Print("broker maintenance failed")
				}
				done()
			}
		}
	}()
	return serve(ctx, ":8443", b, cert, key)
}

func serve(ctx context.Context, address string, handler http.Handler, cert, key string) error {
	server := &http.Server{Addr: address, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 18 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-done:
			return
		case <-ctx.Done():
		}
		shutdown, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	var err error
	if cert != "" {
		err = server.ListenAndServeTLS(cert, key)
	} else {
		err = server.ListenAndServe()
	}
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
