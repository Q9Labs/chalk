package participant

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/Q9Labs/chalk/internal/domain/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/cloudflare"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"
)

type joinTenantCacheStub struct {
	values map[string]string
	getErr error
	sets   int
}

func (c *joinTenantCacheStub) Get(_ context.Context, key string) (string, error) {
	if c.getErr != nil {
		return "", c.getErr
	}
	return c.values[key], nil
}

func (c *joinTenantCacheStub) Set(_ context.Context, key string, value interface{}, _ time.Duration) error {
	c.sets++
	if c.values == nil {
		c.values = map[string]string{}
	}
	text, ok := value.(string)
	if !ok {
		return errors.New("cache value must be string")
	}
	c.values[key] = text
	return nil
}

type joinTenantDBStub struct {
	tenantID       uuid.UUID
	getTenantCalls int
}

func (d *joinTenantDBStub) CountActiveParticipantsByRoom(context.Context, uuid.UUID) (int64, error) {
	panic("unexpected CountActiveParticipantsByRoom")
}

func (d *joinTenantDBStub) ActivateScheduledRoom(context.Context, uuid.UUID) (db.Room, error) {
	panic("unexpected ActivateScheduledRoom")
}

func (d *joinTenantDBStub) CreateParticipant(_ context.Context, arg db.CreateParticipantParams) (db.Participant, error) {
	return db.Participant{
		ID:                      arg.ID,
		RoomID:                  arg.RoomID,
		CloudflareParticipantID: arg.CloudflareParticipantID,
		DisplayName:             arg.DisplayName,
		Role:                    arg.Role,
		JoinedAt:                pgtype.Timestamptz{Time: time.Now(), Valid: true},
		CreatedAt:               time.Now(),
		Metadata:                arg.Metadata,
	}, nil
}

func (d *joinTenantDBStub) CreateRoomWithID(context.Context, db.CreateRoomWithIDParams) (db.Room, error) {
	panic("unexpected CreateRoomWithID")
}

func (d *joinTenantDBStub) GetActiveRecordingByRoom(context.Context, uuid.UUID) (db.Recording, error) {
	panic("unexpected GetActiveRecordingByRoom")
}

func (d *joinTenantDBStub) GetParticipant(context.Context, uuid.UUID) (db.Participant, error) {
	panic("unexpected GetParticipant")
}

func (d *joinTenantDBStub) GetParticipantByCloudflareID(context.Context, string) (db.Participant, error) {
	panic("unexpected GetParticipantByCloudflareID")
}

func (d *joinTenantDBStub) GetParticipantByExternalUserAndRoom(context.Context, db.GetParticipantByExternalUserAndRoomParams) (db.Participant, error) {
	panic("unexpected GetParticipantByExternalUserAndRoom")
}

func (d *joinTenantDBStub) GetRoom(context.Context, uuid.UUID) (db.Room, error) {
	panic("unexpected GetRoom")
}

func (d *joinTenantDBStub) GetRoomHost(context.Context, uuid.UUID) (db.Participant, error) {
	panic("unexpected GetRoomHost")
}

func (d *joinTenantDBStub) GetRoomWithParticipantCount(_ context.Context, id uuid.UUID) (db.GetRoomWithParticipantCountRow, error) {
	name := "room"
	return db.GetRoomWithParticipantCountRow{
		ID:                     id,
		TenantID:               d.tenantID,
		CloudflareMeetingID:    "cf-meeting",
		Name:                   &name,
		Config:                 []byte(`{}`),
		Status:                 "active",
		CreatedAt:              time.Now(),
		UpdatedAt:              time.Now(),
		ActiveParticipantCount: 0,
	}, nil
}

func (d *joinTenantDBStub) GetTenant(_ context.Context, id uuid.UUID) (db.Tenant, error) {
	d.getTenantCalls++
	return db.Tenant{
		ID:                     id,
		MaxParticipantsPerRoom: 100,
		TenantConfig:           []byte(`{"allow_early_join":true}`),
	}, nil
}

func (d *joinTenantDBStub) ListActiveParticipantsByRoom(context.Context, uuid.UUID) ([]db.Participant, error) {
	panic("unexpected ListActiveParticipantsByRoom")
}

func (d *joinTenantDBStub) ListParticipantsByRoom(context.Context, uuid.UUID) ([]db.Participant, error) {
	panic("unexpected ListParticipantsByRoom")
}

func (d *joinTenantDBStub) ParticipantLeave(context.Context, uuid.UUID) (db.Participant, error) {
	panic("unexpected ParticipantLeave")
}

func (d *joinTenantDBStub) ReactivateRoom(context.Context, db.ReactivateRoomParams) (db.Room, error) {
	panic("unexpected ReactivateRoom")
}

func (d *joinTenantDBStub) UpdateParticipant(context.Context, db.UpdateParticipantParams) (db.Participant, error) {
	panic("unexpected UpdateParticipant")
}

type joinTenantCFStub struct{}

func (joinTenantCFStub) CreateMeeting(context.Context, cloudflare.CreateMeetingRequest) (*cloudflare.Meeting, error) {
	panic("unexpected CreateMeeting")
}

func (joinTenantCFStub) EndMeeting(context.Context, string) (*cloudflare.Meeting, error) {
	panic("unexpected EndMeeting")
}

func (joinTenantCFStub) AddParticipant(context.Context, string, cloudflare.AddParticipantRequest) (*cloudflare.Participant, error) {
	return &cloudflare.Participant{ID: "cf-participant", Token: "cf-token"}, nil
}

func (joinTenantCFStub) RemoveParticipant(context.Context, string, string) error {
	panic("unexpected RemoveParticipant")
}

func (joinTenantCFStub) RefreshParticipantToken(context.Context, string, string) (*cloudflare.Participant, error) {
	panic("unexpected RefreshParticipantToken")
}

type joinTenantIssuerStub struct{}

func (joinTenantIssuerStub) GenerateTokenPair(_ auth.Claims) (*auth.TokenPair, error) {
	return &auth.TokenPair{
		AccessToken:  "access",
		RefreshToken: "refresh",
		TokenType:    "Bearer",
		ExpiresIn:    900,
	}, nil
}

func TestJoinRoom_CachesTenantLookup(t *testing.T) {
	tenantID := uuid.New()
	dbStub := &joinTenantDBStub{tenantID: tenantID}
	cacheStub := &joinTenantCacheStub{values: map[string]string{}}
	svc := NewService(dbStub, joinTenantCFStub{}, nil, joinTenantIssuerStub{}, nil, cacheStub)

	_, err := svc.JoinRoom(context.Background(), JoinRoomInput{
		RoomID:      uuid.New(),
		TenantID:    tenantID,
		DisplayName: "A",
		Role:        "participant",
		Metadata:    json.RawMessage(`{}`),
	})
	require.NoError(t, err)

	_, err = svc.JoinRoom(context.Background(), JoinRoomInput{
		RoomID:      uuid.New(),
		TenantID:    tenantID,
		DisplayName: "B",
		Role:        "participant",
		Metadata:    json.RawMessage(`{}`),
	})
	require.NoError(t, err)
	require.Equal(t, 1, dbStub.getTenantCalls)
	require.GreaterOrEqual(t, cacheStub.sets, 1)
}

func TestJoinRoom_InvalidCachedTenantFallsBackToDB(t *testing.T) {
	tenantID := uuid.New()
	dbStub := &joinTenantDBStub{tenantID: tenantID}
	cacheStub := &joinTenantCacheStub{
		values: map[string]string{
			joinTenantCacheKey(tenantID): "{invalid-json",
		},
	}
	svc := NewService(dbStub, joinTenantCFStub{}, nil, joinTenantIssuerStub{}, nil, cacheStub)

	_, err := svc.JoinRoom(context.Background(), JoinRoomInput{
		RoomID:      uuid.New(),
		TenantID:    tenantID,
		DisplayName: "A",
		Role:        "participant",
		Metadata:    json.RawMessage(`{}`),
	})
	require.NoError(t, err)
	require.Equal(t, 1, dbStub.getTenantCalls)
	require.Equal(t, 1, cacheStub.sets)
}

type joinCreateRaceDBStub struct {
	tenantID         uuid.UUID
	roomID           uuid.UUID
	getRoomCalls     int
	createRoomCalls  int
	createParticpant int
}

func (d *joinCreateRaceDBStub) CountActiveParticipantsByRoom(context.Context, uuid.UUID) (int64, error) {
	panic("unexpected CountActiveParticipantsByRoom")
}

func (d *joinCreateRaceDBStub) ActivateScheduledRoom(context.Context, uuid.UUID) (db.Room, error) {
	panic("unexpected ActivateScheduledRoom")
}

func (d *joinCreateRaceDBStub) CreateParticipant(_ context.Context, arg db.CreateParticipantParams) (db.Participant, error) {
	d.createParticpant++
	return db.Participant{
		ID:                      arg.ID,
		RoomID:                  arg.RoomID,
		CloudflareParticipantID: arg.CloudflareParticipantID,
		DisplayName:             arg.DisplayName,
		Role:                    arg.Role,
		JoinedAt:                pgtype.Timestamptz{Time: time.Now(), Valid: true},
		CreatedAt:               time.Now(),
		Metadata:                arg.Metadata,
	}, nil
}

func (d *joinCreateRaceDBStub) CreateRoomWithID(context.Context, db.CreateRoomWithIDParams) (db.Room, error) {
	d.createRoomCalls++
	return db.Room{}, errors.New("duplicate key value violates unique constraint")
}

func (d *joinCreateRaceDBStub) GetActiveRecordingByRoom(context.Context, uuid.UUID) (db.Recording, error) {
	return db.Recording{}, pgx.ErrNoRows
}

func (d *joinCreateRaceDBStub) GetParticipant(context.Context, uuid.UUID) (db.Participant, error) {
	panic("unexpected GetParticipant")
}

func (d *joinCreateRaceDBStub) GetParticipantByCloudflareID(context.Context, string) (db.Participant, error) {
	panic("unexpected GetParticipantByCloudflareID")
}

func (d *joinCreateRaceDBStub) GetParticipantByExternalUserAndRoom(context.Context, db.GetParticipantByExternalUserAndRoomParams) (db.Participant, error) {
	return db.Participant{}, pgx.ErrNoRows
}

func (d *joinCreateRaceDBStub) GetRoom(_ context.Context, id uuid.UUID) (db.Room, error) {
	d.getRoomCalls++
	name := "room-slug"
	return db.Room{
		ID:                  id,
		TenantID:            d.tenantID,
		CloudflareMeetingID: "cf-existing",
		Name:                &name,
		Status:              "active",
		CreatedAt:           time.Now(),
		UpdatedAt:           time.Now(),
		Config:              []byte(`{}`),
	}, nil
}

func (d *joinCreateRaceDBStub) GetRoomHost(context.Context, uuid.UUID) (db.Participant, error) {
	return db.Participant{}, pgx.ErrNoRows
}

func (d *joinCreateRaceDBStub) GetRoomWithParticipantCount(context.Context, uuid.UUID) (db.GetRoomWithParticipantCountRow, error) {
	return db.GetRoomWithParticipantCountRow{}, pgx.ErrNoRows
}

func (d *joinCreateRaceDBStub) GetTenant(_ context.Context, id uuid.UUID) (db.Tenant, error) {
	return db.Tenant{
		ID:                     id,
		MaxParticipantsPerRoom: 100,
		TenantConfig:           []byte(`{"allow_early_join":true}`),
	}, nil
}

func (d *joinCreateRaceDBStub) ListActiveParticipantsByRoom(context.Context, uuid.UUID) ([]db.Participant, error) {
	return nil, nil
}

func (d *joinCreateRaceDBStub) ListParticipantsByRoom(context.Context, uuid.UUID) ([]db.Participant, error) {
	return nil, nil
}

func (d *joinCreateRaceDBStub) ParticipantLeave(context.Context, uuid.UUID) (db.Participant, error) {
	panic("unexpected ParticipantLeave")
}

func (d *joinCreateRaceDBStub) ReactivateRoom(context.Context, db.ReactivateRoomParams) (db.Room, error) {
	panic("unexpected ReactivateRoom")
}

func (d *joinCreateRaceDBStub) UpdateParticipant(context.Context, db.UpdateParticipantParams) (db.Participant, error) {
	panic("unexpected UpdateParticipant")
}

type joinCreateRaceCFStub struct {
	endMeetingCalls []string
	addMeetingIDs   []string
}

func (c *joinCreateRaceCFStub) CreateMeeting(context.Context, cloudflare.CreateMeetingRequest) (*cloudflare.Meeting, error) {
	return &cloudflare.Meeting{ID: "cf-raced-create"}, nil
}

func (c *joinCreateRaceCFStub) EndMeeting(_ context.Context, meetingID string) (*cloudflare.Meeting, error) {
	c.endMeetingCalls = append(c.endMeetingCalls, meetingID)
	return &cloudflare.Meeting{ID: meetingID}, nil
}

func (c *joinCreateRaceCFStub) AddParticipant(_ context.Context, meetingID string, _ cloudflare.AddParticipantRequest) (*cloudflare.Participant, error) {
	c.addMeetingIDs = append(c.addMeetingIDs, meetingID)
	return &cloudflare.Participant{ID: "cf-participant", Token: "cf-token"}, nil
}

func (c *joinCreateRaceCFStub) RemoveParticipant(context.Context, string, string) error {
	panic("unexpected RemoveParticipant")
}

func (c *joinCreateRaceCFStub) RefreshParticipantToken(context.Context, string, string) (*cloudflare.Participant, error) {
	panic("unexpected RefreshParticipantToken")
}

func TestJoinRoom_ReusesExistingRoomAfterCreateRace(t *testing.T) {
	tenantID := uuid.New()
	roomID := uuid.New()
	dbStub := &joinCreateRaceDBStub{
		tenantID: tenantID,
		roomID:   roomID,
	}
	cfStub := &joinCreateRaceCFStub{}
	svc := NewService(dbStub, cfStub, nil, joinTenantIssuerStub{}, nil, nil)

	output, err := svc.JoinRoom(context.Background(), JoinRoomInput{
		RoomID:      roomID,
		RoomName:    "room-slug",
		TenantID:    tenantID,
		DisplayName: "A",
		Role:        "participant",
		Metadata:    json.RawMessage(`{}`),
	})
	require.NoError(t, err)
	require.Equal(t, roomID, output.Room.ID)
	require.False(t, output.RoomCreated)
	require.Equal(t, 1, dbStub.createRoomCalls)
	require.Equal(t, 1, dbStub.getRoomCalls)
	require.Equal(t, []string{"cf-raced-create"}, cfStub.endMeetingCalls)
	require.Equal(t, []string{"cf-existing"}, cfStub.addMeetingIDs)
}
