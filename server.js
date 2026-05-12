import 'dotenv/config'
import express from 'express'
import pg from 'pg'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { Pool } = pg
const app = express()
const port = process.env.PORT || 3000
const databaseUrl = process.env.EXTERNAL_DATABASE_URL
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const distPath = path.join(__dirname, 'dist')
const indexPath = path.join(distPath, 'index.html')
const logPrefix = '[smartwild-dashboard]'
const incidentChannel = 'incidents_changed'
const incidentStreamClients = new Set()

function log(message, details = {}) {
  console.log(
    `${logPrefix} ${message}`,
    JSON.stringify({
      at: new Date().toISOString(),
      ...details,
    }),
  )
}

function logError(message, error, details = {}) {
  console.error(
    `${logPrefix} ${message}`,
    JSON.stringify({
      at: new Date().toISOString(),
      error: error.message,
      code: error.code,
      stack: error.stack,
      ...details,
    }),
  )
}

function getDatabaseUrlHost(url) {
  if (!url) {
    return null
  }

  try {
    return new URL(url).host
  } catch (error) {
    logError('invalid database URL format', error)
    return 'invalid-url'
  }
}

process.on('uncaughtException', (error) => {
  logError('uncaught exception', error)
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason))
  logError('unhandled rejection', error)
})

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

function sendIncidentStreamEvent(event, payload = {}) {
  const data = JSON.stringify({
    at: new Date().toISOString(),
    ...payload,
  })

  for (const response of incidentStreamClients) {
    response.write(`event: ${event}\n`)
    response.write(`data: ${data}\n\n`)
  }
}

async function fetchIncidents() {
  if (!pool) {
    throw new Error('EXTERNAL_DATABASE_URL is not configured')
  }

  const totalResult = await pool.query('SELECT COUNT(*)::int AS total FROM incidents')
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

  return {
    totalRows: totalResult.rows[0]?.total ?? null,
    rows,
  }
}

function startIncidentChangeListener() {
  if (!databaseUrl) {
    log('incident realtime disabled: missing database URL')
    return
  }

  let reconnectTimer = null
  let client = null

  async function connect() {
    try {
      client = new pg.Client({
        connectionString: databaseUrl,
        ssl: databaseUrl.includes('localhost')
          ? false
          : {
              rejectUnauthorized: false,
            },
      })

      client.on('notification', (message) => {
        let payload = null

        if (message.payload) {
          try {
            payload = JSON.parse(message.payload)
          } catch (error) {
            payload = message.payload
            logError('incident realtime payload parse failed', error, {
              payload: message.payload,
            })
          }
        }

        log('incident database change received', {
          channel: message.channel,
          payload: message.payload,
          streamClients: incidentStreamClients.size,
        })
        sendIncidentStreamEvent('changed', {
          channel: message.channel,
          payload,
        })
      })

      client.on('error', (error) => {
        logError('incident realtime listener error', error)
      })

      client.on('end', () => {
        log('incident realtime listener disconnected')
        reconnectTimer = setTimeout(connect, 5000)
      })

      await client.connect()
      await client.query(`LISTEN ${incidentChannel}`)
      log('incident realtime listener connected', { channel: incidentChannel })
    } catch (error) {
      logError('incident realtime listener failed', error)
      reconnectTimer = setTimeout(connect, 5000)
    }
  }

  connect()

  process.on('SIGTERM', async () => {
    clearTimeout(reconnectTimer)
    await client?.end()
  })
}

app.get('/api/health', (_request, response) => {
  log('health check', { databaseConfigured: Boolean(pool) })
  response.json({
    ok: true,
    databaseConfigured: Boolean(pool),
  })
})

app.get('/api/incidents', async (_request, response) => {
  const startedAt = Date.now()
  log('incidents request received')

  if (!pool) {
    log('incidents request rejected: missing database URL')
    response.status(500).json({ error: 'EXTERNAL_DATABASE_URL is not configured' })
    return
  }

  try {
    const { rows, totalRows } = await fetchIncidents()

    log('incidents request completed', {
      durationMs: Date.now() - startedAt,
      totalRowsInTable: totalRows,
      returnedRows: rows.length,
      sampleIds: rows.slice(0, 5).map((row) => row.id),
      sampleTypes: rows.slice(0, 5).map((row) => row.type),
    })

    response.json({ incidents: rows })
  } catch (error) {
    logError('incidents request failed', error, {
      durationMs: Date.now() - startedAt,
    })
    response.status(500).json({ error: 'Failed to load incidents' })
  }
})

app.get('/api/incidents/stream', (request, response) => {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  response.write(': connected\n\n')

  incidentStreamClients.add(response)
  log('incident stream client connected', { streamClients: incidentStreamClients.size })

  const heartbeat = setInterval(() => {
    response.write(': heartbeat\n\n')
  }, 25000)

  request.on('close', () => {
    clearInterval(heartbeat)
    incidentStreamClients.delete(response)
    log('incident stream client disconnected', { streamClients: incidentStreamClients.size })
  })
})

app.use(express.static(distPath))

app.get(/.*/, (_request, response) => {
  response.sendFile(indexPath)
})

app.listen(port, '0.0.0.0', () => {
  log('server started', {
    port,
    host: '0.0.0.0',
    databaseConfigured: Boolean(pool),
    databaseUrlHost: getDatabaseUrlHost(databaseUrl),
    distExists: fs.existsSync(distPath),
    indexExists: fs.existsSync(indexPath),
  })
  startIncidentChangeListener()
})
