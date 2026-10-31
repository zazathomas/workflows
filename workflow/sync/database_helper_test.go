package sync

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	testcontainers "github.com/testcontainers/testcontainers-go"
	testmysql "github.com/testcontainers/testcontainers-go/modules/mysql"
	testpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/argoproj/argo-workflows/v4/config"
	"github.com/argoproj/argo-workflows/v4/util/logging"
	"github.com/argoproj/argo-workflows/v4/util/sqldb"
	syncdb "github.com/argoproj/argo-workflows/v4/util/sync/db"
)

const (
	testDBName     = `sync`
	testDBUser     = `user`
	testDBPassword = `pass`
)

// Each engine is started once per package. Individual tests use separate databases.
var testContainers struct {
	sync.Mutex
	configs  map[sqldb.DBType]config.SyncConfig
	cleanups []func()
}

var testDatabaseSequence atomic.Uint64

func TestMain(m *testing.M) {
	code := m.Run()
	for _, cleanup := range testContainers.cleanups {
		cleanup()
	}
	os.Exit(code)
}

// createTestDBSession creates a test database session
func createTestDBSession(ctx context.Context, t *testing.T, dbType sqldb.DBType) (syncdb.Info, func(), config.SyncConfig, error) {
	t.Helper()

	cfg, termContainerFn, err := createIsolatedTestDatabase(ctx, t, dbType)
	if err != nil {
		return syncdb.Info{}, func() {}, cfg, err
	}
	username := testDBUser
	if dbType == sqldb.MySQL {
		username = "root"
	}

	// Create SessionProxy instead of raw Session
	sessionProxy, err := sqldb.NewSessionProxy(ctx, sqldb.SessionProxyConfig{
		DBConfig:   cfg.DBConfig,
		Username:   username,
		Password:   testDBPassword,
		MaxRetries: 5,
		BaseDelay:  100 * time.Millisecond,
		MaxDelay:   30 * time.Second,
	})
	if err != nil {
		termContainerFn()
		return syncdb.Info{}, func() {}, cfg, err
	}

	info := syncdb.Info{
		Config:       syncdb.ConfigFromConfig(&cfg),
		SessionProxy: sessionProxy,
	}
	require.NotNil(t, info.SessionProxy, "failed to create database session proxy")
	deferfn := func() {
		info.SessionProxy.Close()
		termContainerFn()
	}

	info.Migrate(ctx)
	require.NotNil(t, info.SessionProxy, "failed to migrate database")

	// Mark this controller as alive immediately
	_, err = info.SessionProxy.Session(ctx).Collection(info.Config.ControllerTable).
		Insert(&syncdb.ControllerHealthRecord{
			Controller: info.Config.ControllerName,
			Time:       time.Now(),
		})
	if err != nil {
		info.SessionProxy.Close()
		return info, deferfn, cfg, err
	}

	return info, deferfn, cfg, nil
}

func createIsolatedTestDatabase(ctx context.Context, t *testing.T, dbType sqldb.DBType) (config.SyncConfig, func(), error) {
	t.Helper()
	testContainers.Lock()
	if testContainers.configs == nil {
		testContainers.configs = make(map[sqldb.DBType]config.SyncConfig)
	}
	cfg, ok := testContainers.configs[dbType]
	if !ok {
		var cleanup func()
		var err error
		switch dbType {
		case sqldb.Postgres:
			cfg, cleanup, err = setupPostgresContainer(ctx, t)
		case sqldb.MySQL:
			cfg, cleanup, err = setupMySQLContainer(ctx, t)
		default:
			err = fmt.Errorf("unsupported test database type %q", dbType)
		}
		if err != nil {
			testContainers.Unlock()
			return config.SyncConfig{}, nil, err
		}
		testContainers.configs[dbType] = cfg
		testContainers.cleanups = append(testContainers.cleanups, cleanup)
	}
	testContainers.Unlock()

	name := fmt.Sprintf("argo_test_%d", testDatabaseSequence.Add(1))
	var driver, dsn string
	if dbType == sqldb.Postgres {
		db := cfg.PostgreSQL.DatabaseConfig
		driver = "postgres"
		dsn = fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=%s sslmode=disable", db.Host, db.Port, testDBUser, testDBPassword, testDBName)
	} else {
		db := cfg.MySQL.DatabaseConfig
		driver = "mysql"
		dsn = fmt.Sprintf("root:%s@tcp(%s)/%s", testDBPassword, net.JoinHostPort(db.Host, strconv.Itoa(db.Port)), testDBName)
	}
	admin, err := sql.Open(driver, dsn)
	if err != nil {
		return config.SyncConfig{}, nil, err
	}
	if _, err = admin.ExecContext(ctx, "CREATE DATABASE "+name); err != nil {
		_ = admin.Close()
		return config.SyncConfig{}, nil, err
	}
	// Copy the nested config so concurrent tests cannot overwrite another database name.
	if dbType == sqldb.Postgres {
		postgres := *cfg.PostgreSQL
		postgres.Database = name
		cfg.PostgreSQL = &postgres
	} else {
		mysql := *cfg.MySQL
		mysql.Database = name
		cfg.MySQL = &mysql
	}
	cleanup := func() {
		if _, err := admin.ExecContext(context.Background(), "DROP DATABASE "+name); err != nil {
			t.Errorf("drop test database %s: %v", name, err)
		}
		_ = admin.Close()
	}
	return cfg, cleanup, nil
}

func TestDatabaseSessionsAreIsolated(t *testing.T) {
	for _, dbType := range testDBTypes {
		t.Run(string(dbType), func(t *testing.T) {
			ctx := logging.TestContext(t.Context())
			first, cleanupFirst, _, err := createTestDBSession(ctx, t, dbType)
			require.NoError(t, err)
			defer cleanupFirst()
			second, cleanupSecond, _, err := createTestDBSession(ctx, t, dbType)
			require.NoError(t, err)
			defer cleanupSecond()

			_, err = first.SessionProxy.Session(ctx).Collection(first.Config.ControllerTable).Insert(&syncdb.ControllerHealthRecord{
				Controller: "isolation-check",
				Time:       time.Now(),
			})
			require.NoError(t, err)
			firstCount, err := first.SessionProxy.Session(ctx).Collection(first.Config.ControllerTable).Count()
			require.NoError(t, err)
			secondCount, err := second.SessionProxy.Session(ctx).Collection(second.Config.ControllerTable).Count()
			require.NoError(t, err)
			require.EqualValues(t, 2, firstCount)
			require.EqualValues(t, 1, secondCount)
		})
	}
}

// setupPostgresContainer sets up a Postgres test container and returns the config and cleanup function
func setupPostgresContainer(ctx context.Context, t *testing.T) (config.SyncConfig, func(), error) {
	postgresContainer, err := testpostgres.Run(ctx,
		"postgres:17.4-alpine",
		testpostgres.WithDatabase(testDBName),
		testpostgres.WithUsername(testDBUser),
		testpostgres.WithPassword(testDBPassword),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).
				WithStartupTimeout(15*time.Second)),
	)
	if err != nil {
		if postgresContainer != nil {
			_ = testcontainers.TerminateContainer(postgresContainer)
		}
		return config.SyncConfig{}, nil, err
	}

	host, err := postgresContainer.Host(ctx)
	if err != nil {
		_ = testcontainers.TerminateContainer(postgresContainer)
		return config.SyncConfig{}, nil, err
	}
	portS, err := postgresContainer.MappedPort(ctx, "5432/tcp")
	if err != nil {
		_ = testcontainers.TerminateContainer(postgresContainer)
		return config.SyncConfig{}, nil, err
	}
	port, err := strconv.Atoi(portS.Port())
	if err != nil {
		_ = testcontainers.TerminateContainer(postgresContainer)
		return config.SyncConfig{}, nil, err
	}

	cfg := config.SyncConfig{
		ControllerName: "test1",
		DBConfig: config.DBConfig{
			PostgreSQL: &config.PostgreSQLConfig{
				DatabaseConfig: config.DatabaseConfig{
					Database: testDBName,
					Host:     host,
					Port:     port,
				},
			},
		},
	}

	termContainerFn := func() {
		if err := testcontainers.TerminateContainer(postgresContainer); err != nil {
			fmt.Fprintf(os.Stderr, "failed to terminate container: %s\n", err)
		}
	}

	return cfg, termContainerFn, nil
}

// setupMySQLContainer sets up a MySQL test container and returns the config and cleanup function
func setupMySQLContainer(ctx context.Context, t *testing.T) (config.SyncConfig, func(), error) {
	mysqlContainer, err := testmysql.Run(ctx,
		"mysql:8.4.5",
		testmysql.WithDatabase(testDBName),
		testmysql.WithUsername("root"),
		testmysql.WithPassword(testDBPassword),
	)
	if err != nil {
		if mysqlContainer != nil {
			_ = testcontainers.TerminateContainer(mysqlContainer)
		}
		return config.SyncConfig{}, nil, err
	}

	host, err := mysqlContainer.Host(ctx)
	if err != nil {
		_ = testcontainers.TerminateContainer(mysqlContainer)
		return config.SyncConfig{}, nil, err
	}
	portS, err := mysqlContainer.MappedPort(ctx, "3306/tcp")
	if err != nil {
		_ = testcontainers.TerminateContainer(mysqlContainer)
		return config.SyncConfig{}, nil, err
	}
	port, err := strconv.Atoi(portS.Port())
	if err != nil {
		_ = testcontainers.TerminateContainer(mysqlContainer)
		return config.SyncConfig{}, nil, err
	}

	cfg := config.SyncConfig{
		ControllerName: "test1",
		DBConfig: config.DBConfig{
			MySQL: &config.MySQLConfig{
				DatabaseConfig: config.DatabaseConfig{
					Database: testDBName,
					Host:     host,
					Port:     port,
				},
			},
		},
	}

	termContainerFn := func() {
		if err := testcontainers.TerminateContainer(mysqlContainer); err != nil {
			fmt.Fprintf(os.Stderr, "failed to terminate container: %s\n", err)
		}
	}

	return cfg, termContainerFn, nil
}
