import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import {
  Circle,
  GeoJSON,
  MapContainer,
  Marker,
  TileLayer,
  useMapEvents,
} from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import './App.css'

const mapCenter = [39.5, -98.35]
const incidentRadiusMeters = 200
const padUsQueryUrl =
  'https://edits.nationalmap.gov/arcgis/rest/services/PAD-US/PAD_US_4_1/MapServer/0/query'
const nationalBoundarySources = [
  {
    id: 'nps',
    url: 'https://services1.arcgis.com/fBc8EJBxQRMcHlei/ArcGIS/rest/services/NPSParkBoundaries/FeatureServer/0/query',
    idField: 'FID',
    outFields: 'FID,UNIT_NAME,STATE,REGION,UNIT_TYPE',
    where: "UNIT_TYPE IN ('National Park', 'National Preserve', 'National Reserve')",
  },
  {
    id: 'fws',
    url: 'https://services.arcgis.com/QVENGdaPbd4LUkLV/arcgis/rest/services/National_Wildlife_Refuge_System_Boundaries/FeatureServer/0/query',
    idField: 'OBJECTID',
    outFields: 'OBJECTID,ORGNAME,ORGCODE,LIT,RSL_TYPE,FWSREGION',
    where: "RSL_TYPE IN ('NWR', 'WMA', 'WPA')",
  },
]
const zoneWords = /\b(zone|zoning|unit|wilderness|habitat|management|buffer)\b/i
const incidentColors = {
  animal: '#4da3ff',
  human: '#42f59b',
}
const incidentTypeLabels = {
  animal_on_road: 'Animal on road',
  person_on_road: 'Person on road',
  stopped_vehicle: 'Stopped vehicle',
  road_obstruction: 'Road obstruction',
  unknown: 'Unknown incident',
}

function getIncidentCategory(type) {
  return type === 'animal_on_road' ? 'animal' : 'human'
}

function normalizeIncident(row) {
  return {
    ...row,
    category: getIncidentCategory(row.type),
    title: incidentTypeLabels[row.type] || 'Security incident',
    description: row.recommended_message || 'No recommended message provided.',
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
  }
}

function boundsToBox(bounds) {
  return [
    Number(bounds.getWest().toFixed(5)),
    Number(bounds.getSouth().toFixed(5)),
    Number(bounds.getEast().toFixed(5)),
    Number(bounds.getNorth().toFixed(5)),
  ]
}

function buildProtectedAreaUrl(box, zoom) {
  const [xmin, ymin, xmax, ymax] = box
  const bbox = {
    xmin,
    ymin,
    xmax,
    ymax,
    spatialReference: { wkid: 4326 },
  }
  const offset = zoom < 5 ? 0.08 : zoom < 7 ? 0.03 : zoom < 10 ? 0.01 : 0.0025
  const minimumAcres = zoom < 5 ? 5000 : zoom < 7 ? 2500 : zoom < 9 ? 500 : 0
  const areaFilter = minimumAcres ? `GIS_Acres > ${minimumAcres}` : '1=1'
  const sanctuaryFilter = [
    "Des_Tp IN ('NP', 'NWR')",
    "Loc_Ds LIKE '%National Park%'",
    "Loc_Ds LIKE '%National Preserve%'",
    "Loc_Ds LIKE '%National Wildlife Refuge%'",
    "Unit_Nm LIKE '%National Park%'",
    "Unit_Nm LIKE '%National Preserve%'",
    "Unit_Nm LIKE '%National Wildlife Refuge%'",
    "Unit_Nm LIKE '%Wildlife Refuge%'",
    "Unit_Nm LIKE '%Wildlife Management Area%'",
    "Unit_Nm LIKE '%Waterfowl Production Area%'",
  ].join(' OR ')

  return `${padUsQueryUrl}?${new URLSearchParams({
    f: 'json',
    where: `${areaFilter} AND (${sanctuaryFilter})`,
    outFields:
      'OBJECTID,Category,Own_Name,Mang_Name,Des_Tp,Loc_Ds,Unit_Nm,Loc_Nm,State_Nm,GIS_Acres,IUCN_Cat,GAP_Sts',
    returnGeometry: 'true',
    geometryType: 'esriGeometryEnvelope',
    geometry: JSON.stringify(bbox),
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    resultRecordCount: zoom < 5 ? '500' : zoom < 7 ? '1500' : '2000',
    orderByFields: 'GIS_Acres DESC',
    geometryPrecision: zoom < 8 ? '4' : '5',
    maxAllowableOffset: String(offset),
  })}`
}

function buildNationalBoundaryUrl(source) {
  return `${source.url}?${new URLSearchParams({
    f: 'json',
    where: source.where,
    outFields: source.outFields,
    returnGeometry: 'true',
    outSR: '4326',
    resultRecordCount: '2000',
    geometryPrecision: '3',
    maxAllowableOffset: '0.05',
  })}`
}

function getFeatureBounds(feature) {
  const coordinates = feature.geometry.coordinates.flat(1)
  const lngs = coordinates.map(([lng]) => lng)
  const lats = coordinates.map(([, lat]) => lat)

  return {
    west: Math.min(...lngs),
    south: Math.min(...lats),
    east: Math.max(...lngs),
    north: Math.max(...lats),
  }
}

function getBoundsArea(bounds) {
  return Math.max(bounds.east - bounds.west, 0) * Math.max(bounds.north - bounds.south, 0)
}

function containsBounds(outer, inner) {
  return (
    outer.west <= inner.west &&
    outer.south <= inner.south &&
    outer.east >= inner.east &&
    outer.north >= inner.north
  )
}

function annotateBoundaryTypes(features) {
  const withBounds = features.map((feature) => {
    const bounds = getFeatureBounds(feature)

    return {
      feature,
      bounds,
      area: getBoundsArea(bounds),
    }
  })

  return withBounds.map(({ feature, bounds, area }, index) => {
    const tags = feature.properties.tags
    const searchableText = [
      tags.Unit_Nm,
      tags.UNIT_NAME,
      tags.Loc_Nm,
      tags.Loc_Ds,
      tags.Des_Tp,
      tags.Category,
      tags.IUCN_Cat,
      tags.ORGNAME,
      tags.RSL_TYPE,
    ]
      .filter(Boolean)
      .join(' ')
    const isNamedZone = zoneWords.test(searchableText)
    const isNestedBoundary = withBounds.some((candidate, candidateIndex) => {
      const candidateTags = candidate.feature.properties.tags
      const sameNamedArea =
        candidateTags.Unit_Nm &&
        tags.Unit_Nm &&
        candidateTags.Unit_Nm === tags.Unit_Nm &&
        candidateTags.Category !== tags.Category

      if (!sameNamedArea || candidateIndex === index || candidate.area <= area * 1.8) {
        return false
      }

      return containsBounds(candidate.bounds, bounds)
    })

    return {
      ...feature,
      properties: {
        ...feature.properties,
        isZoneBoundary: tags.Category ? tags.Category !== 'Fee' || isNestedBoundary : isNamedZone,
      },
    }
  })
}

function arcGisToFeatureCollection(data, sourceId = 'pad-us', idField = 'OBJECTID') {
  const features = (data.features || [])
    .filter((feature) => feature.geometry?.rings?.length)
    .map((feature) => {
      const attributes = feature.attributes || {}

      return {
        type: 'Feature',
        properties: {
          id: `${sourceId}/${attributes[idField]}`,
          tags: attributes,
        },
        geometry: {
          type: 'Polygon',
          coordinates: feature.geometry.rings,
        },
      }
    })

  return {
    type: 'FeatureCollection',
    features: annotateBoundaryTypes(features),
  }
}

async function loadNationalBoundarySources() {
  const collections = await Promise.all(
    nationalBoundarySources.map(async (source) => {
      const response = await fetch(buildNationalBoundaryUrl(source))

      if (!response.ok) {
        throw new Error(`${source.id.toUpperCase()} request failed: ${response.status}`)
      }

      return arcGisToFeatureCollection(await response.json(), source.id, source.idField)
    }),
  )

  return mergeFeatureCollections(collections)
}

function mergeFeatureCollections(collections) {
  const featuresById = new Map()

  collections.forEach((collection) => {
    ;(collection.features || []).forEach((feature) => {
      featuresById.set(feature.properties.id, feature)
    })
  })

  return {
    type: 'FeatureCollection',
    features: annotateBoundaryTypes([...featuresById.values()]),
  }
}

function ProtectedBoundaryLayer() {
  const [areas, setAreas] = useState({ type: 'FeatureCollection', features: [] })
  const requestIdRef = useRef(0)
  const debounceTimerRef = useRef()
  const loadBoundaries = useCallback(async (activeMap) => {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId

    try {
      const zoom = activeMap.getZoom()
      let nextAreas

      if (zoom < 5) {
        nextAreas = await loadNationalBoundarySources()
      } else {
        const response = await fetch(buildProtectedAreaUrl(boundsToBox(activeMap.getBounds()), zoom))

        if (!response.ok) {
          throw new Error(`PAD-US request failed: ${response.status}`)
        }

        nextAreas = arcGisToFeatureCollection(await response.json())
      }

      if (requestId === requestIdRef.current && nextAreas.features.length > 0) {
        setAreas(nextAreas)
      }
    } catch (error) {
      console.error(error)
    }
  }, [])

  const scheduleLoadBoundaries = useCallback(
    (activeMap) => {
      window.clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = window.setTimeout(() => {
        loadBoundaries(activeMap)
      }, 250)
    },
    [loadBoundaries],
  )

  const map = useMapEvents({
    moveend() {
      scheduleLoadBoundaries(map)
    },
    zoomend() {
      scheduleLoadBoundaries(map)
    },
  })

  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadBoundaries(map)
    }, 0)

    return () => {
      window.clearTimeout(timer)
      window.clearTimeout(debounceTimerRef.current)
    }
  }, [loadBoundaries, map])

  const dataKey = useMemo(
    () => areas.features.map((feature) => feature.properties.id).join('|'),
    [areas],
  )

  return (
    <GeoJSON
      key={dataKey}
      data={areas}
      interactive={false}
      style={(feature) => ({
        color: '#a58adb',
        dashArray: feature?.properties?.isZoneBoundary ? '6 7' : undefined,
        fill: true,
        fillColor: '#a58adb',
        fillOpacity: 0.015,
        opacity: feature?.properties?.isZoneBoundary ? 0.72 : 0.95,
        weight: feature?.properties?.isZoneBoundary ? 1.35 : 2,
      })}
    />
  )
}

function getIncidentIcon(type) {
  return L.divIcon({
    className: '',
    html: `<span class="incident-pulse incident-pulse-${type}"><span></span></span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  })
}

function useIncidents() {
  const [incidents, setIncidents] = useState([])

  useEffect(() => {
    const controller = new AbortController()

    async function loadIncidents() {
      try {
        const response = await fetch('/api/incidents', {
          signal: controller.signal,
        })

        if (!response.ok) {
          throw new Error(`Incidents request failed: ${response.status}`)
        }

        const data = await response.json()
        setIncidents(
          (data.incidents || [])
            .map(normalizeIncident)
            .filter(
              (incident) => Number.isFinite(incident.latitude) && Number.isFinite(incident.longitude),
            ),
        )
      } catch (error) {
        if (error.name !== 'AbortError') {
          console.error(error)
        }
      }
    }

    loadIncidents()
    const interval = window.setInterval(loadIncidents, 30000)

    return () => {
      controller.abort()
      window.clearInterval(interval)
    }
  }, [])

  return incidents
}

function IncidentLayer({ incidents, onSelectIncident }) {
  return incidents.map((incident) => {
    const position = [incident.latitude, incident.longitude]
    const color = incidentColors[incident.category]

    return (
      <Fragment key={incident.id}>
        <Circle
          center={position}
          radius={incidentRadiusMeters}
          className={`incident-radius incident-radius-${incident.category}`}
          pathOptions={{
            color,
            fillColor: color,
            fillOpacity: 0.1,
            opacity: 0.85,
            weight: 1.4,
          }}
        />
        <Marker
          position={position}
          icon={getIncidentIcon(incident.category)}
          eventHandlers={{
            click: () => {
              onSelectIncident(incident)
            },
          }}
        />
      </Fragment>
    )
  })
}

function IncidentDetailsPanel({ incident, onClose }) {
  if (!incident) {
    return null
  }

  const color = incidentColors[incident.category]
  const label = incident.category === 'animal' ? 'Animal incident' : 'Human / security incident'

  return (
    <aside
      className="incident-panel"
      style={{
        backdropFilter: 'blur(34px) saturate(1.8) contrast(0.92)',
        WebkitBackdropFilter: 'blur(34px) saturate(1.8) contrast(0.92)',
      }}
      aria-label="Incident details"
    >
      <button className="panel-close" type="button" aria-label="Close details" onClick={onClose}>
        +
      </button>
      <div className="panel-status" style={{ '--incident-color': color }}>
        <span />
        {label}
      </div>
      <h1>{incident.title}</h1>
      <p>{incident.description}</p>
      <dl>
        <div>
          <dt>Latitude</dt>
          <dd>{incident.latitude.toFixed(4)}</dd>
        </div>
        <div>
          <dt>Longitude</dt>
          <dd>{incident.longitude.toFixed(4)}</dd>
        </div>
        <div>
          <dt>Priority</dt>
          <dd>{incident.priority}</dd>
        </div>
        <div>
          <dt>Confidence</dt>
          <dd>
            {typeof incident.confidence === 'number'
              ? `${Math.round(incident.confidence * 100)}%`
              : 'Unknown'}
          </dd>
        </div>
        <div>
          <dt>Road</dt>
          <dd>{incident.road_name || 'Unknown'}</dd>
        </div>
      </dl>
    </aside>
  )
}

function App() {
  const incidents = useIncidents()
  const [selectedIncident, setSelectedIncident] = useState(null)

  return (
    <main className="map-page" aria-label="Full page map">
      <MapContainer
        center={mapCenter}
        zoom={4}
        minZoom={3}
        maxZoom={19}
        scrollWheelZoom
        zoomControl={false}
        className="full-map"
      >
        <TileLayer
          attribution='Protected areas: <a href="https://www.usgs.gov/programs/gap-analysis-project/science/protected-areas">USGS PAD-US</a> | Base map: &copy; <a href="https://carto.com/attributions">CARTO</a>'
          className="quiet-dark"
          url="https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png"
        />
        <ProtectedBoundaryLayer />
        <IncidentLayer incidents={incidents} onSelectIncident={setSelectedIncident} />
      </MapContainer>
      <IncidentDetailsPanel
        incident={selectedIncident}
        onClose={() => {
          setSelectedIncident(null)
        }}
      />
    </main>
  )
}

export default App
