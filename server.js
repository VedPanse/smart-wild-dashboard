import 'dotenv/config'
import express from 'express'
import pg from 'pg'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { Pool } = pg
const app = express()
const port = process.env.PORT || 3000
const databaseUrl = process.env.EXTERNAL_DATABASE_URL
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes('localhost')
        ? false
        : {
            rejectUnauthorized: false,
          },
    })
  : null

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    databaseConfigured: Boolean(pool),
  })
})

app.get('/api/incidents', async (_request, response) => {
  if (!pool) {
    response.status(500).json({ error: 'EXTERNAL_DATABASE_URL is not configured' })
    return
  }

  try {
    const { rows } = await pool.query(`
      SELECT
        id,
        type,
        NULL::double precision AS confidence,
        'active' AS status,
        occurred_at,
        reported_at,
        latitude,
        longitude,
        road_name,
        direction,
        mile_marker,
        camera_id,
        priority,
        recommended_message,
        snapshot_url,
        video_clip_url,
        created_at,
        created_at AS updated_at
      FROM incidents
      ORDER BY occurred_at DESC
      LIMIT 500
    `)

    response.json({ incidents: rows })
  } catch (error) {
    console.error('Failed to load incidents', error)
    response.status(500).json({ error: 'Failed to load incidents' })
  }
})

app.use(express.static(path.join(__dirname, 'dist')))

app.get(/.*/, (_request, response) => {
  response.sendFile(path.join(__dirname, 'dist', 'index.html'))
})

app.listen(port, () => {
  console.log(`SmartWild dashboard listening on port ${port}`)
})
