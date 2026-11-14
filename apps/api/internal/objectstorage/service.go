package objectstorage

import "context"

type Service struct {
	store Store
}

func NewService(store Store) Service {
	return Service{store: store}
}

func (s Service) PutObject(ctx context.Context, input PutObjectInput) (Object, error) {
	if s.store == nil {
		return Object{}, ErrStoreUnavailable
	}
	if err := normalizePutObjectInput(&input); err != nil {
		return Object{}, err
	}

	return s.store.PutObject(ctx, input)
}

func (s Service) GetObject(ctx context.Context, key string) (ObjectReader, error) {
	if s.store == nil {
		return ObjectReader{}, ErrStoreUnavailable
	}

	key, err := objectKey(key)
	if err != nil {
		return ObjectReader{}, ErrInvalidObjectKey
	}

	return s.store.GetObject(ctx, key)
}

func (s Service) InspectObject(ctx context.Context, key string) (ObjectFacts, error) {
	if s.store == nil {
		return ObjectFacts{}, ErrStoreUnavailable
	}

	key, err := objectKey(key)
	if err != nil {
		return ObjectFacts{}, ErrInvalidObjectKey
	}

	return s.store.InspectObject(ctx, key)
}

func (s Service) DeleteObject(ctx context.Context, key string) error {
	if s.store == nil {
		return ErrStoreUnavailable
	}

	key, err := objectKey(key)
	if err != nil {
		return ErrInvalidObjectKey
	}

	return s.store.DeleteObject(ctx, key)
}

func (s Service) CreateUploadURL(ctx context.Context, input CreateUploadURLInput) (SignedURL, error) {
	if s.store == nil {
		return SignedURL{}, ErrStoreUnavailable
	}
	if err := normalizeCreateUploadURLInput(&input); err != nil {
		return SignedURL{}, err
	}

	return s.store.CreateUploadURL(ctx, input)
}

func (s Service) CreateDownloadURL(ctx context.Context, input CreateDownloadURLInput) (SignedURL, error) {
	if s.store == nil {
		return SignedURL{}, ErrStoreUnavailable
	}
	if err := normalizeCreateDownloadURLInput(&input); err != nil {
		return SignedURL{}, err
	}

	return s.store.CreateDownloadURL(ctx, input)
}

func (s Service) CreateDeleteURL(ctx context.Context, input CreateDeleteURLInput) (SignedURL, error) {
	if s.store == nil {
		return SignedURL{}, ErrStoreUnavailable
	}
	key, err := objectKey(input.Key)
	if err != nil {
		return SignedURL{}, ErrInvalidObjectKey
	}
	if input.ExpiresIn <= 0 {
		return SignedURL{}, ErrInvalidURLExpiration
	}
	input.Key = key
	return s.store.CreateDeleteURL(ctx, input)
}
