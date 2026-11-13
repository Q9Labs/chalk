package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

func changedDigest(want, got map[string]string) (string, bool) {
	for name, digest := range want {
		if got[name] != digest {
			return name, true
		}
	}
	return "", false
}

// checkNoResidualPurgeRows finds approved rows that survived: stable PK scopes outlive the deletion of
// their parents and memberships.
func checkNoResidualPurgeRows(ctx context.Context, tx pgx.Tx, catalog purgeCatalog, temp map[string]string) error {
	for name, source := range temp {
		table, _ := catalog.table(name)
		var residual int64
		if err := tx.QueryRow(ctx, `select count(*) from `+purgeName(name)+` d join `+source+` s on `+purgePKJoin(table, "d", "s")).Scan(&residual); err != nil {
			return err
		}
		if residual != 0 {
			return fmt.Errorf("residual approved rows in %s", name)
		}
	}
	return nil
}

// retainedPurgeDigests hashes every remaining public row so the caller can match it with the
// retained pre-erase projection.
func retainedPurgeDigests(ctx context.Context, tx pgx.Tx, catalog purgeCatalog) (map[string]string, error) {
	remaining := make(map[string]string)
	for _, table := range catalog.Tables {
		digest, err := purgeTableDigest(ctx, tx, table.Name)
		if err != nil {
			return nil, err
		}
		remaining[table.Name] = digest
	}
	return remaining, nil
}

func purgeTableDigest(ctx context.Context, tx pgx.Tx, table string) (string, error) {
	rows, err := tx.Query(ctx, `select to_jsonb(r)::text from `+purgeName(table)+` r order by to_jsonb(r)::text`)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	hash := sha256.New()
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			return "", err
		}
		hash.Write([]byte(value + "\n"))
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func checkPurgeGuardsRestored(ctx context.Context, tx pgx.Tx, schemaDigest string) error {
	restored, err := loadPurgeCatalog(ctx, tx)
	if err != nil {
		return err
	}
	digest, err := restored.digest()
	if err != nil {
		return err
	}
	if digest != schemaDigest {
		return errors.New("purge guard schema was not restored")
	}
	return nil
}
