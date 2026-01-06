package postgres

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestDefaultConfig_Values checks that all default values are set correctly
func TestDefaultConfig_Values(t *testing.T) {
	config := DefaultConfig()

	assert.Equal(t, "localhost", config.Host)
	assert.Equal(t, 5432, config.Port)
	assert.Equal(t, "default_user", config.User)
	assert.Equal(t, "default_password", config.Password)
	assert.Equal(t, "default_db", config.Database)
	assert.Equal(t, "disable", config.SSLMode)
	assert.Equal(t, int32(25), config.MaxConns)
	assert.Equal(t, int32(5), config.MinConns)
	assert.Equal(t, time.Hour, config.MaxConnLifetime)
	assert.Equal(t, 30*time.Minute, config.MaxConnIdleTime)
	assert.Equal(t, time.Minute, config.HealthCheckPeriod)
}

// TestDefaultConfig_ReturnsNewInstance checks that each call returns independent instance
func TestDefaultConfig_ReturnsNewInstance(t *testing.T) {
	config1 := DefaultConfig()
	config2 := DefaultConfig()

	// Modify config1
	config1.Host = "modified"
	config1.Port = 1234

	// config2 should be unchanged
	assert.Equal(t, "localhost", config2.Host)
	assert.Equal(t, 5432, config2.Port)
}

// TestConfig_DSN_Format checks that DSN string format is correct
func TestConfig_DSN_Format(t *testing.T) {
	config := DefaultConfig()
	dsn := config.DSN()

	// Check that all parts are included in DSN
	assert.Contains(t, dsn, "host=localhost")
	assert.Contains(t, dsn, "port=5432")
	assert.Contains(t, dsn, "user=default_user")
	assert.Contains(t, dsn, "password=default_password")
	assert.Contains(t, dsn, "dbname=default_db")
	assert.Contains(t, dsn, "sslmode=disable")
}

// TestConfig_DSN_CustomValues checks DSN with custom values
func TestConfig_DSN_CustomValues(t *testing.T) {
	config := Config{
		Host:     "db.example.com",
		Port:     5433,
		User:     "custom_user",
		Password: "custom_pass",
		Database: "custom_db",
		SSLMode:  "require",
	}
	dsn := config.DSN()

	assert.Contains(t, dsn, "host=db.example.com")
	assert.Contains(t, dsn, "port=5433")
	assert.Contains(t, dsn, "user=custom_user")
	assert.Contains(t, dsn, "password=custom_pass")
	assert.Contains(t, dsn, "dbname=custom_db")
	assert.Contains(t, dsn, "sslmode=require")
}

// TestConfig_DSN_SpecialCharacters checks DSN handles passwords with special characters
func TestConfig_DSN_SpecialCharacters(t *testing.T) {
	testCases := []struct {
		name     string
		password string
	}{
		{"simple password", "simple123"},
		{"password with special chars", "p@ssw0rd!#$%"},
		{"password with equals", "pass=word"},
		{"password with spaces", "pass word"},
		{"password with quotes", "pass'word\"test"},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			config := Config{
				Host:     "localhost",
				Port:     5432,
				User:     "user",
				Password: tc.password,
				Database: "db",
				SSLMode:  "disable",
			}
			dsn := config.DSN()

			// Password should appear in DSN as-is
			assert.Contains(t, dsn, "password="+tc.password)
		})
	}
}

// TestConfig_DSN_AllFieldsIncluded checks that all config fields appear in DSN
func TestConfig_DSN_AllFieldsIncluded(t *testing.T) {
	config := Config{
		Host:     "test_host",
		Port:     9999,
		User:     "test_user",
		Password: "test_pass",
		Database: "test_db",
		SSLMode:  "require",
	}
	dsn := config.DSN()

	requiredFields := []string{
		"host=test_host",
		"port=9999",
		"user=test_user",
		"password=test_pass",
		"dbname=test_db",
		"sslmode=require",
	}

	for _, field := range requiredFields {
		assert.Contains(t, dsn, field, "DSN should contain %s", field)
	}
}

// TestConfig_DSN_EmptyPassword checks DSN with empty password
func TestConfig_DSN_EmptyPassword(t *testing.T) {
	config := Config{
		Host:     "localhost",
		Port:     5432,
		User:     "user",
		Password: "",
		Database: "db",
		SSLMode:  "disable",
	}
	dsn := config.DSN()

	// When password is empty, it should NOT be included (intentional behavior)
	assert.NotContains(t, dsn, "password=")
}

// TestConfig_DSN_ZeroPort checks DSN with port 0
func TestConfig_DSN_ZeroPort(t *testing.T) {
	config := Config{
		Host:     "localhost",
		Port:     0,
		User:     "user",
		Password: "pass",
		Database: "db",
		SSLMode:  "disable",
	}
	dsn := config.DSN()

	assert.Contains(t, dsn, "port=0")
}

// TestConfig_DSN_MultipleSSLModes checks different SSL modes produce correct DSN
func TestConfig_DSN_MultipleSSLModes(t *testing.T) {
	sslModes := []string{"disable", "require", "verify-ca", "verify-full"}

	for _, sslMode := range sslModes {
		t.Run(sslMode, func(t *testing.T) {
			config := Config{
				Host:     "localhost",
				Port:     5432,
				User:     "user",
				Password: "pass",
				Database: "db",
				SSLMode:  sslMode,
			}
			dsn := config.DSN()

			assert.Contains(t, dsn, "sslmode="+sslMode)
		})
	}
}

// TestConfig_DSN_HostWithIP checks DSN with IP address as host
func TestConfig_DSN_HostWithIP(t *testing.T) {
	config := Config{
		Host:     "192.168.1.1",
		Port:     5432,
		User:     "user",
		Password: "pass",
		Database: "db",
		SSLMode:  "disable",
	}
	dsn := config.DSN()

	assert.Contains(t, dsn, "host=192.168.1.1")
}

// TestConfig_DSN_DatabaseWithSpecialChars checks DSN with database name containing special chars
func TestConfig_DSN_DatabaseWithSpecialChars(t *testing.T) {
	config := Config{
		Host:     "localhost",
		Port:     5432,
		User:     "user",
		Password: "pass",
		Database: "db_test-2024",
		SSLMode:  "disable",
	}
	dsn := config.DSN()

	assert.Contains(t, dsn, "dbname=db_test-2024")
}

// TestConfig_ConnPoolSettings checks that connection pool settings are valid
func TestConfig_ConnPoolSettings(t *testing.T) {
	config := DefaultConfig()

	require.Greater(t, config.MaxConns, int32(0), "MaxConns should be greater than 0")
	require.Greater(t, config.MinConns, int32(0), "MinConns should be greater than 0")
	require.LessOrEqual(t, config.MinConns, config.MaxConns, "MinConns should be <= MaxConns")
	require.Greater(t, config.MaxConnLifetime, time.Duration(0), "MaxConnLifetime should be positive")
	require.Greater(t, config.MaxConnIdleTime, time.Duration(0), "MaxConnIdleTime should be positive")
	require.Greater(t, config.HealthCheckPeriod, time.Duration(0), "HealthCheckPeriod should be positive")
}

// TestConfig_ModifyAfterCreation checks that Config can be modified after creation
func TestConfig_ModifyAfterCreation(t *testing.T) {
	config := DefaultConfig()

	// Modify fields
	config.Host = "newhost"
	config.Port = 1234
	config.User = "newuser"
	config.Password = "newpass"
	config.Database = "newdb"
	config.SSLMode = "require"
	config.MaxConns = 50
	config.MinConns = 10
	config.MaxConnLifetime = 2 * time.Hour
	config.MaxConnIdleTime = 1 * time.Hour
	config.HealthCheckPeriod = 2 * time.Minute

	// Check modifications took effect
	assert.Equal(t, "newhost", config.Host)
	assert.Equal(t, 1234, config.Port)
	assert.Equal(t, "newuser", config.User)
	assert.Equal(t, "newpass", config.Password)
	assert.Equal(t, "newdb", config.Database)
	assert.Equal(t, "require", config.SSLMode)
	assert.Equal(t, int32(50), config.MaxConns)
	assert.Equal(t, int32(10), config.MinConns)
	assert.Equal(t, 2*time.Hour, config.MaxConnLifetime)
	assert.Equal(t, 1*time.Hour, config.MaxConnIdleTime)
	assert.Equal(t, 2*time.Minute, config.HealthCheckPeriod)

	// DSN should reflect modifications
	dsn := config.DSN()
	assert.Contains(t, dsn, "host=newhost")
	assert.Contains(t, dsn, "port=1234")
}

// TestConfig_DSN_Consistency checks that calling DSN multiple times returns same result
func TestConfig_DSN_Consistency(t *testing.T) {
	config := Config{
		Host:     "localhost",
		Port:     5432,
		User:     "user",
		Password: "pass",
		Database: "db",
		SSLMode:  "disable",
	}

	dsn1 := config.DSN()
	dsn2 := config.DSN()
	dsn3 := config.DSN()

	assert.Equal(t, dsn1, dsn2)
	assert.Equal(t, dsn2, dsn3)
}

// TestConfig_ZeroValues checks behavior with zero values
func TestConfig_ZeroValues(t *testing.T) {
	var config Config
	dsn := config.DSN()

	// Should still produce a valid DSN string structure
	assert.Contains(t, dsn, "host=")
	assert.Contains(t, dsn, "port=")
	assert.Contains(t, dsn, "user=")
	// Password is intentionally omitted when empty
	assert.NotContains(t, dsn, "password=")
	assert.Contains(t, dsn, "dbname=")
	assert.Contains(t, dsn, "sslmode=")
}
