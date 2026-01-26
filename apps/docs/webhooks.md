# Chalk Webhooks

Chalk delivers post-meeting data (recordings, transcripts, summaries) via webhooks. When a meeting ends and processing completes, Chalk sends a signed HTTP POST to your configured endpoint.

## Configuration

Configure webhooks via the tenant config API:

```bash
curl -X PUT https://api.chalk.video/v1/tenant/config \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "webhook_url": "https://your-app.com/webhooks/chalk",
    "webhook_secret": "whsec_your_secret_here",
    "include_recording": true,
    "include_transcript": true,
    "include_summary": true,
    "include_action_items": true
  }'
```

| Field | Type | Description |
|-------|------|-------------|
| `webhook_url` | string | HTTPS endpoint to receive webhooks |
| `webhook_secret` | string | Secret for HMAC signature verification |
| `include_recording` | boolean | Include recording download URLs |
| `include_transcript` | boolean | Include full transcript text |
| `include_summary` | boolean | Include AI-generated summary |
| `include_action_items` | boolean | Include extracted action items |

## Webhook Headers

Every webhook request includes these headers:

| Header | Description |
|--------|-------------|
| `X-Chalk-Signature` | HMAC-SHA256 signature: `sha256={hex}` |
| `X-Chalk-Timestamp` | Unix timestamp (seconds) when sent |
| `X-Chalk-Event` | Event type: `meeting.recording_ready` |
| `Content-Type` | `application/json` |

## Payload Structure

```json
{
  "event": "meeting.recording_ready",
  "timestamp": "2024-01-15T10:30:00Z",
  "meeting": {
    "id": "mtg_abc123",
    "name": "Physics 101 - Lecture 5",
    "started_at": "2024-01-15T09:00:00Z",
    "ended_at": "2024-01-15T10:00:00Z",
    "duration_seconds": 3600,
    "participant_count": 25
  },
  "recording": {
    "id": "rec_xyz789",
    "duration_seconds": 3600,
    "size_bytes": 524288000,
    "download_url": "https://cdn.chalk.video/rec_xyz789.mp4?token=...",
    "download_api": "https://api.chalk.video/v1/recordings/rec_xyz789/download",
    "expires_at": "2024-01-16T10:30:00Z"
  },
  "transcript": {
    "id": "trs_def456",
    "text": "Welcome to today's lecture on quantum mechanics...",
    "word_count": 8542,
    "language": "en",
    "provider": "deepgram",
    "segments": [
      { "start": 0.0, "end": 2.5, "text": "Welcome to today's lecture" },
      { "start": 2.5, "end": 5.1, "text": "on quantum mechanics." }
    ]
  },
  "summary": "This lecture covered the fundamentals of quantum mechanics...",
  "action_items": [
    "Complete problem set 5 by Friday",
    "Read chapters 7-8 before next class"
  ],
  "errors": []
}
```

### Graceful Degradation

If a component fails to process, the webhook still delivers with partial data. Check the `errors` array:

```json
{
  "event": "meeting.recording_ready",
  "meeting": { ... },
  "recording": { ... },
  "transcript": null,
  "summary": null,
  "errors": [
    {
      "field": "transcript",
      "code": "TRANSCRIPTION_FAILED",
      "message": "Audio quality insufficient for transcription"
    }
  ]
}
```

## SDK Verification

### Using createWebhookHandler

```typescript
import { createWebhookHandler } from '@q9labs/chalk-core';

const handler = createWebhookHandler({
  secret: process.env.CHALK_WEBHOOK_SECRET,
  tolerance: 300, // 5 minute tolerance (default)
});

// In your route handler
app.post('/webhooks/chalk', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const event = await handler.verify(
      req.body.toString(),
      req.headers['x-chalk-signature'] as string,
      req.headers['x-chalk-timestamp'] as string
    );

    // TypeScript knows the payload structure
    const { meeting, transcript, recording } = event.payload;

    console.log(`Meeting ${meeting.name} ended`);

    if (transcript) {
      console.log(`Transcript: ${transcript.word_count} words`);
    }

    if (recording) {
      console.log(`Recording: ${recording.download_url}`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook verification failed:', err);
    res.sendStatus(401);
  }
});
```

### Using Express Middleware

```typescript
import express from 'express';
import { chalkWebhookMiddleware } from '@q9labs/chalk-core';

const app = express();

app.post(
  '/webhooks/chalk',
  express.raw({ type: 'application/json' }),
  chalkWebhookMiddleware({ secret: process.env.CHALK_WEBHOOK_SECRET }),
  (req, res) => {
    // req.chalkEvent is typed and verified
    const { meeting, transcript, summary, action_items } = req.chalkEvent.payload;

    // Store in database
    await db.meetings.update({
      where: { id: meeting.id },
      data: {
        transcript: transcript?.text,
        summary,
        actionItems: action_items,
      },
    });

    res.sendStatus(200);
  }
);
```

## Manual Verification (Python)

```python
import hmac
import hashlib
import time

def verify_webhook(body: bytes, signature: str, timestamp: str, secret: str) -> bool:
    # Check timestamp freshness (5 minute tolerance)
    ts = int(timestamp)
    now = int(time.time())
    if abs(now - ts) > 300:
        return False

    # Compute expected signature
    message = f"{timestamp}.{body.decode('utf-8')}"
    expected = "sha256=" + hmac.new(
        secret.encode('utf-8'),
        message.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()

    # Constant-time comparison
    return hmac.compare_digest(signature, expected)

# Flask example
@app.route('/webhooks/chalk', methods=['POST'])
def handle_webhook():
    if not verify_webhook(
        request.data,
        request.headers.get('X-Chalk-Signature'),
        request.headers.get('X-Chalk-Timestamp'),
        os.environ['CHALK_WEBHOOK_SECRET']
    ):
        return 'Unauthorized', 401

    payload = request.get_json()
    # Process payload...
    return '', 200
```

## Retry Policy

Chalk retries failed webhook deliveries with exponential backoff:

| Attempt | Delay | Total Time |
|---------|-------|------------|
| 1 | Immediate | 0s |
| 2 | 1 minute | 1m |
| 3 | 5 minutes | 6m |
| 4 | 30 minutes | 36m |
| 5 | 2 hours | 2h 36m |
| 6 | 6 hours | 8h 36m |

A delivery is considered successful when your endpoint returns a `2xx` status code. After 6 failed attempts, the webhook is marked as failed and no further retries occur.

### Retry Headers

Retry requests include additional headers:

| Header | Description |
|--------|-------------|
| `X-Chalk-Retry-Count` | Number of previous attempts (0-5) |
| `X-Chalk-Original-Timestamp` | Timestamp of first delivery attempt |

## Testing with ngrok

1. Install and start ngrok:
```bash
ngrok http 3000
```

2. Configure the forwarding URL:
```bash
curl -X PUT https://api.chalk.video/v1/tenant/config \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"webhook_url": "https://abc123.ngrok.io/webhooks/chalk"}'
```

3. Create a test meeting and end it to trigger the webhook.

### Test Endpoint

Use the webhook test endpoint to send a sample payload:

```bash
curl -X POST https://api.chalk.video/v1/webhooks/test \
  -H "Authorization: Bearer $API_KEY"
```

This sends a sample `meeting.recording_ready` event to your configured endpoint.

## Security Best Practices

1. **Always verify signatures** - Never process unverified webhooks
2. **Check timestamp freshness** - Reject webhooks older than 5 minutes
3. **Use HTTPS** - Webhook URLs must use HTTPS in production
4. **Rotate secrets** - Periodically rotate your webhook secret
5. **Idempotency** - Handle duplicate deliveries gracefully using `meeting.id`
6. **Respond quickly** - Return 200 within 30 seconds; process async if needed

## Error Codes

| Code | Description |
|------|-------------|
| `WEBHOOK_SIGNATURE_INVALID` | HMAC signature verification failed |
| `WEBHOOK_TIMESTAMP_EXPIRED` | Timestamp outside tolerance window |
| `WEBHOOK_PAYLOAD_INVALID` | JSON parsing or schema validation failed |
