import alchemy from 'alchemy'
import { Astro, CustomDomain } from 'alchemy/cloudflare'

const app = await alchemy('chalk-docs', {
	stage: process.env.STAGE ?? 'prod',
	phase: process.env.DESTROY ? 'destroy' : 'up',
})

const site = await Astro('chalk-docs-site', {
	assets: './dist',
	adopt: true,
})

// Custom domain with SSL
if (process.env.CLOUDFLARE_ZONE_ID) {
	await CustomDomain('chalk-docs-domain', {
		name: 'docs.chalk.q9labs.ai',
		zoneId: process.env.CLOUDFLARE_ZONE_ID,
		workerName: 'chalk-docs-chalk-docs-site-prod',
		adopt: true,
	})
}

console.log({
	workerUrl: site.url,
	customDomain: 'https://docs.chalk.q9labs.ai',
})

await app.finalize()
