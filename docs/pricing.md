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

### Startup (~200 MAU, current prod)
- **Users:** 30 concurrent (10 rooms × 3p)
- **Hours:** 80/month (4hr/day × 20 days)
- **Bandwidth:** 1,680 GB
- **Cloudflare:** $34 (1TB free applied)
- **AWS Infra:** $174
- **Total:** **~$210/month** ($1.05/MAU)

### Growth (~1,000 MAU)
- **Users:** 100 concurrent (33 rooms × 3p)
- **Hours:** 120/month (6hr/day × 20 days)
- **Bandwidth:** 8,400 GB
- **Cloudflare:** $370
- **AWS Infra:** $319
- **Total:** **~$690/month** ($0.69/MAU)

### Scale (~5,000 MAU)
- **Users:** 500 concurrent (125 rooms × 4p)
- **Hours:** 160/month (8hr/day × 20 days)
- **Bandwidth:** 84,000 GB
- **Cloudflare:** $4,150
- **AWS Infra:** $800
- **Total:** **~$4,950/month** ($0.99/MAU)

## AWS Infrastructure

| Component | Startup | Growth | Scale |
|-----------|---------|--------|-------|
| ECS | $15 (1× t3.small) | $61 (2× t3.medium) | $200 (4× t3.large) |
| Aurora Serverless v2 | $44 (0.5-2 ACU) | $175 (2-8 ACU) | $350 (4-16 ACU) |
| ElastiCache | $24 (2× t3.micro) | $50 (2× t3.small) | $150 (2× r6g.large) |
| NAT Gateway | $33 (1×) | $33 (1×) | $99 (3×) |
| ALB + API Gateway | $26 | $35 | $100 |
| Other (WAF, KMS, CW) | $32 | $50 | $101 |
| **Total** | **$174** | **$404** | **$1,000** |

*Current prod (Startup tier) verified Jan 2026. Scale up as load grows.*

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
  const awsInfra = budget <= 300 ? 174 : 404; // Startup vs Growth tier
  const available = (budget - awsInfra) + 50; // +$50 free tier
  const hours = available / costPerHour[participants];
  return Math.round(hours * 60);
}

// Examples (with $174 startup infra):
calculateMinutes(250, 3)  → 72,000 min  (1,200 hrs)
calculateMinutes(500, 3)  → 216,000 min (3,600 hrs)
calculateMinutes(1000, 3) → 502,857 min (8,381 hrs)
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
