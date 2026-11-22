package postgres

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/helperaccess"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (r EpisodeLifecycleRepository) StartDeviceRequest(ctx context.Context, request helperaccess.DeviceEnrollment) error {
	return r.transaction(ctx, func(q *sqlc.Queries, _ pgx.Tx) error {
		if err := q.ExpireHelperDeviceRequests(ctx); err != nil {
			return err
		}
		var deviceID pgtype.UUID
		if request.Registered {
			device, err := q.FindHelperDeviceByCredential(ctx, request.CredentialHash[:])
			if err != nil {
				return deviceRequestError(err)
			}
			if device.PublicKey != request.PublicKey || device.TenantID != uuid(request.IntendedTenant) {
				return helperaccess.ErrDeviceUnavailable
			}
			deviceID, request.Name = device.ID, device.Name
		}
		return q.StartHelperDeviceRequest(ctx, sqlc.StartHelperDeviceRequestParams{
			ID: uuid(request.ID), CodeHash: request.CodeHash[:], PollHash: request.PollHash[:],
			Name: request.Name, PublicKey: request.PublicKey, CredentialHash: request.CredentialHash[:],
			DeviceID: deviceID, IntendedTenantID: uuid(request.IntendedTenant),
		})
	})
}

func (r EpisodeLifecycleRepository) LookupDeviceRequest(ctx context.Context, tenant utilities.ID, code [32]byte) (offer helperaccess.DeviceOffer, err error) {
	err = r.transaction(ctx, func(q *sqlc.Queries, _ pgx.Tx) error {
		request, err := q.LookupHelperDeviceRequest(ctx, sqlc.LookupHelperDeviceRequestParams{CodeHash: code[:], TenantID: uuid(tenant)})
		if err != nil {
			return deviceRequestError(err)
		}
		offer = helperaccess.DeviceOffer{RequestID: id(request.ID).String(), Name: request.Name, Fingerprint: request.PublicKey}
		return nil
	})
	return offer, err
}

func (r EpisodeLifecycleRepository) ApproveDeviceRequest(ctx context.Context, tenant, requestID utilities.ID, share helperaccess.DeviceShare, refresh bool) error {
	return r.transaction(ctx, func(q *sqlc.Queries, _ pgx.Tx) error {
		request, err := q.LockHelperDeviceRequest(ctx, sqlc.LockHelperDeviceRequestParams{ID: uuid(requestID), IntendedTenantID: uuid(tenant)})
		if err != nil {
			return deviceRequestError(err)
		}
		if refresh != (request.ApprovedShare != nil) {
			return helperaccess.ErrDeviceUnavailable
		}
		share.Binding.DeviceKey = request.PublicKey
		if refresh {
			var previous helperaccess.DeviceShare
			if err := json.Unmarshal(request.ApprovedShare, &previous); err != nil {
				return err
			}
			if previous != share {
				return helperaccess.ErrDeviceUnavailable
			}
		}
		deviceID := request.DeviceID
		if !deviceID.Valid {
			deviceID = request.ID
			err = q.RegisterHelperDevice(ctx, sqlc.RegisterHelperDeviceParams{
				ID: deviceID, TenantID: uuid(tenant), Name: request.Name, PublicKey: request.PublicKey, CredentialHash: request.CredentialHash,
			})
			if err != nil {
				if uniqueViolation(err) {
					return helperaccess.ErrDeviceUnavailable
				}
				return err
			}
		} else {
			device, err := q.LockActiveHelperDevice(ctx, deviceID)
			if err != nil {
				return deviceRequestError(err)
			}
			if device.TenantID != uuid(tenant) {
				return helperaccess.ErrDeviceUnavailable
			}
		}
		payload, err := json.Marshal(share)
		if err != nil {
			return err
		}
		return q.ApproveHelperDeviceRequest(ctx, sqlc.ApproveHelperDeviceRequestParams{ID: request.ID, DeviceID: deviceID, ApprovedShare: payload})
	})
}

func (r EpisodeLifecycleRepository) PollDeviceRequest(ctx context.Context, poll [32]byte) (approval *helperaccess.DeviceApproval, err error) {
	err = r.transaction(ctx, func(q *sqlc.Queries, _ pgx.Tx) error {
		request, err := q.PollHelperDeviceRequest(ctx, poll[:])
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil || request.ApprovedShare == nil {
			return err
		}
		if _, err := q.LockActiveHelperDevice(ctx, request.DeviceID); err != nil {
			return deviceRequestError(err)
		}
		var share helperaccess.DeviceShare
		if err := json.Unmarshal(request.ApprovedShare, &share); err != nil {
			return err
		}
		approval = &helperaccess.DeviceApproval{DeviceID: id(request.DeviceID), Share: share, ExpiresAt: request.ApprovalExpiresAt.Time}
		return nil
	})
	return approval, err
}

// Sign under the same row lock that revocation takes. The share recheck does
// not hold a database connection or lock while it consults other services.
func (r EpisodeLifecycleRepository) IssueDeviceTicket(ctx context.Context, device utilities.ID, issue func() (helperaccess.DevicePoll, error)) (ticket helperaccess.DevicePoll, err error) {
	err = r.transaction(ctx, func(q *sqlc.Queries, _ pgx.Tx) error {
		if _, err := q.LockActiveHelperDevice(ctx, uuid(device)); err != nil {
			return deviceRequestError(err)
		}
		ticket, err = issue()
		return err
	})
	if err != nil {
		return helperaccess.DevicePoll{}, err
	}
	return ticket, nil
}

func (r EpisodeLifecycleRepository) RegisterHelperLoopbackDevice(ctx context.Context, device, tenant utilities.ID, key string, unusedCredentialHash [32]byte) error {
	return r.transaction(ctx, func(q *sqlc.Queries, _ pgx.Tx) error {
		return q.RegisterHelperLoopbackDevice(ctx, sqlc.RegisterHelperLoopbackDeviceParams{
			ID: uuid(device), TenantID: uuid(tenant), PublicKey: key, CredentialHash: unusedCredentialHash[:],
		})
	})
}

func (r EpisodeLifecycleRepository) WithActiveHelperLoopbackDevice(ctx context.Context, tenant utilities.ID, key string, issue func() error) error {
	return r.transaction(ctx, func(q *sqlc.Queries, _ pgx.Tx) error {
		_, err := q.LockActiveHelperLoopbackDevice(ctx, sqlc.LockActiveHelperLoopbackDeviceParams{
			TenantID: uuid(tenant), PublicKey: key,
		})
		if err != nil {
			return deviceRequestError(err)
		}
		return issue()
	})
}

func (r EpisodeLifecycleRepository) ListHelperDevices(ctx context.Context, tenant utilities.ID) (devices []helperaccess.Device, err error) {
	err = r.transaction(ctx, func(q *sqlc.Queries, _ pgx.Tx) error {
		rows, err := q.ReadHelperDevices(ctx, uuid(tenant))
		devices = make([]helperaccess.Device, 0, len(rows))
		for _, row := range rows {
			devices = append(devices, helperaccess.Device{ID: id(row.ID).String(), Name: row.Name})
		}
		return err
	})
	return devices, err
}

func (r EpisodeLifecycleRepository) RevokeHelperDevice(ctx context.Context, tenant, device utilities.ID) error {
	return r.transaction(ctx, func(q *sqlc.Queries, _ pgx.Tx) error {
		return q.RevokeHelperDevice(ctx, sqlc.RevokeHelperDeviceParams{ID: uuid(device), TenantID: uuid(tenant)})
	})
}

func deviceRequestError(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return helperaccess.ErrDeviceUnavailable
	}
	return err
}
