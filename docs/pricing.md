# Chalk Pricing Model

## Cloudflare RealtimeKit

- **$0.05/GB** egress (SFU → clients)
- **1 TB free** per month ($50 value)
- **Ingress FREE** (client → SFU)

## Bandwidth Formula

```
SFU Egress = N participants × (N-1) streams
GB/hour = Egress × 0.35 GB (medium quality 784 Kbps)
Cost/hour = GB × $0.05
```

## Cost Per Room

| Participants | Egress Streams | GB/Hour | Cost/Hour |
|--------------|----------------|---------|-----------|
| 2 (1:1) | 2 | 0.7 | $0.035 |
| 3 | 6 | 2.1 | $0.105 |
| 5 | 20 | 7.0 | $0.35 |
| 10 | 90 | 31.5 | $1.58 |

## Monthly Cost Tiers

### Startup
- **Users:** 60 concurrent (20 rooms × 3p)
- **Hours:** 80/month (4hr/day × 20 days)
- **Bandwidth:** 3,360 GB
- **Cloudflare:** $118
- **AWS Infra:** $92
- **Total:** **$210/month** ($3.50/user)

### Growth
- **Users:** 300 concurrent (100 rooms × 3p)
- **Hours:** 120/month (6hr/day × 20 days)
- **Bandwidth:** 25,200 GB
- **Cloudflare:** $1,210
- **AWS Infra:** $319
- **Total:** **$1,529/month** ($5.10/user)

### Scale
- **Users:** 2,000 concurrent (500 rooms × 4p)
- **Hours:** 160/month (8hr/day × 20 days)
- **Bandwidth:** 336,000 GB
- **Cloudflare:** $16,750
- **AWS Infra:** $800
- **Total:** **$17,550/month** ($8.78/user)

## AWS Infrastructure

| Component | Startup | Growth | Scale |
|-----------|---------|--------|-------|
| ECS | $15 | $61 | $200 |
| Aurora Serverless v2 | $44 | $175 | $250 |
| ElastiCache | $12 | $25 | $150 |
| API Gateway | $5 | $25 | $100 |
| R2 Storage | $1 | $3 | $15 |
| Other | $15 | $30 | $85 |
| **Total** | **$92** | **$319** | **$800** |

## Recording Storage

| Storage | Pricing | Use Case |
|---------|---------|----------|
| R2 (0-7 days) | $0.015/GB/month, FREE egress | Hot storage |
| S3 Glacier (7+ days) | $0.004/GB/month | Archive |
| S3 Deep Archive (90+ days) | $0.00099/GB/month | Compliance |

**Recording size** = live bandwidth × duration
- 2p × 1hr = 0.7 GB
- 3p × 1hr = 2.1 GB
- 5p × 1hr = 7.0 GB
- 10p × 1hr = 31.5 GB

## Quick Calculator

```javascript
function calculateMinutes(budget, participants) {
  const costPerHour = { 2: 0.035, 3: 0.105, 5: 0.35, 10: 1.58 };
  const awsInfra = budget <= 200 ? 92 : 319;
  const available = (budget - awsInfra) + 50; // +$50 free tier
  const hours = available / costPerHour[participants];
  return Math.round(hours * 60);
}

// Examples:
calculateMinutes(200, 3)  → 90,286 min  (1,505 hrs)
calculateMinutes(500, 3)  → 132,000 min (2,200 hrs)
calculateMinutes(1000, 3) → 417,429 min (6,957 hrs)
```

## Capacity by Budget

| Budget | 2 Participants | 3 Participants | 5 Participants | 10 Participants |
|--------|----------------|----------------|----------------|-----------------|
| $100 | 99,429 min | 33,143 min | 9,943 min | 2,203 min |
| $200 | 270,857 min | 90,286 min | 27,086 min | 6,000 min |
| $500 | 396,000 min | 132,000 min | 39,600 min | 8,772 min |
| $1,000 | 1,252,286 min | 417,429 min | 125,229 min | 27,747 min |

## Cost Optimization

1. **Adaptive bitrate** - 50-70% savings on poor networks
2. **Audio-only mode** - 95% reduction for listeners
3. **Participant limits** - Cap at 5-6 (sweet spot: 3-5)
4. **Screen share optimization** - Low FPS for static content
5. **Idle detection** - Pause video when tab unfocused
6. **Recording lifecycle** - Move to Glacier after 7 days, delete after 30-90 days
7. **Volume pricing** - Negotiate with Cloudflare at scale

## Key Insights

- **1:1 calls are extremely cost-effective** (~$0.035/hr)
- **3-5 participants is the sweet spot** (balance value/cost)
- **Quadratic scaling** - 10p costs 45× more than 2p (inherent to SFU)
- **Free tier is valuable** - 1TB = 1,429 hours of 1:1 or 476 hours of 3p
- **Infrastructure costs matter** - Reduces available minutes, especially at lower budgets

## Use Case Recommendations

| Use Case | Budget | Capacity |
|----------|--------|----------|
| Small tutoring (mostly 1:1) | $200-300/mo | 1,500-4,500 hrs |
| Study groups (3-5p) | $300-700/mo | 500-2,000 hrs |
| Virtual classrooms (10+p) | $1,000-2,000/mo | 100-500 hrs |
| Mixed usage school | $1,000-3,000/mo | Varies by mix |
