export const MAPTILER_KEY = 'LFj7KqSSfDZvpzi5Ca7q';

const FONT_REGULAR = ['Roboto Regular', 'Noto Sans Regular'];
const FONT_MEDIUM = ['Roboto Medium', 'Noto Sans Regular'];

export function createGtaSaStyle() {
  return {
    version: 8,
    name: 'GTA San Andreas Kamchatka 3D',
    glyphs: `https://api.maptiler.com/fonts/{fontstack}/{range}.pbf?key=${MAPTILER_KEY}`,
    light: {
      anchor: 'viewport',
      color: '#ffffff',
      intensity: 0.68,
      position: [1.35, 215, 30]
    },
    sources: {
      openmaptiles: {
        type: 'vector',
        url: `https://api.maptiler.com/tiles/v3/tiles.json?key=${MAPTILER_KEY}`
      },
      'terrain-dem': {
        type: 'raster-dem',
        url: `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${MAPTILER_KEY}`,
        tileSize: 256
      },
      'hillshade-dem': {
        type: 'raster-dem',
        url: `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${MAPTILER_KEY}`,
        tileSize: 256
      },
      satellite: {
        type: 'raster',
        url: `https://api.maptiler.com/tiles/satellite-v2/tiles.json?key=${MAPTILER_KEY}`,
        tileSize: 256
      },
      route: {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: []
        }
      }
    },
    terrain: {
      source: 'terrain-dem',
      exaggeration: 1.5
    },
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: {
          'background-color': '#3b4f36'
        }
      },
      {
        id: 'landcover-greenery',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'landcover',
        filter: [
          'in',
          ['get', 'class'],
          ['literal', ['wood', 'forest', 'scrub', 'grass', 'meadow', 'farmland']]
        ],
        paint: {
          'fill-color': '#3b4f36',
          'fill-opacity': 1
        }
      },
      {
        id: 'landuse-urban-bright',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'landuse',
        filter: [
          'in',
          ['get', 'class'],
          [
            'literal',
            [
              'residential',
              'suburbs',
              'neighbourhood',
              'commercial',
              'retail',
              'hospital',
              'school',
              'college',
              'university'
            ]
          ]
        ],
        paint: {
          'fill-color': '#eaeaea',
          'fill-opacity': 1
        }
      },
      {
        id: 'landuse-urban-industrial',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'landuse',
        filter: [
          'in',
          ['get', 'class'],
          [
            'literal',
            [
              'industrial',
              'construction',
              'railway',
              'aerodrome',
              'quarry',
              'garages',
              'harbour',
              'port',
              'brownfield',
              'landfill',
              'military'
            ]
          ]
        ],
        paint: {
          'fill-color': '#9a9a9a',
          'fill-opacity': 1
        }
      },
      {
        id: 'aeroway-urban',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'aeroway',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: {
          'fill-color': '#9a9a9a',
          'fill-opacity': 1
        }
      },
      {
        id: 'landuse-greenery',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'landuse',
        filter: [
          'in',
          ['get', 'class'],
          ['literal', ['park', 'forest', 'cemetery', 'recreation_ground', 'village_green', 'allotments', 'grass']]
        ],
        paint: {
          'fill-color': '#3b4f36',
          'fill-opacity': 1
        }
      },
      {
        id: 'park-greenery',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'park',
        paint: {
          'fill-color': '#3b4f36',
          'fill-opacity': 1
        }
      },
      {
        id: 'hillshade',
        type: 'hillshade',
        source: 'hillshade-dem',
        paint: {
          'hillshade-method': 'standard',
          'hillshade-illumination-direction': 315,
          'hillshade-exaggeration': 0.75,
          'hillshade-shadow-color': 'rgba(8, 10, 8, 0.68)',
          'hillshade-highlight-color': 'rgba(0, 0, 0, 0)',
          'hillshade-accent-color': 'rgba(8, 10, 8, 0.28)'
        }
      },
      {
        id: 'water',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'water',
        paint: {
          'fill-color': '#29486b'
        }
      },
      {
        id: 'waterway',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'waterway',
        paint: {
          'line-color': '#29486b',
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 16, 6]
        }
      },
      {
        id: 'satellite-layer',
        type: 'raster',
        source: 'satellite',
        layout: {
          visibility: 'none'
        },
        paint: {
          'raster-opacity': 1,
          'raster-contrast': 0.08,
          'raster-saturation': -0.05
        }
      },

      // Unpaved, Tracks, Paths & Service Driveways (#9c886b fill / #4a3f30 outline)
      {
        id: 'road-dirt-casing',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        minzoom: 12,
        filter: [
          'any',
          ['in', ['get', 'class'], ['literal', ['service', 'track', 'path']]],
          ['==', ['get', 'surface'], 'unpaved']
        ],
        layout: {
          'line-cap': 'round',
          'line-join': 'round'
        },
        paint: {
          'line-color': '#4a3f30',
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 12, 2, 15, 5, 18, 11.5]
        }
      },
      {
        id: 'road-dirt-fill',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        minzoom: 12,
        filter: [
          'any',
          ['in', ['get', 'class'], ['literal', ['service', 'track', 'path']]],
          ['==', ['get', 'surface'], 'unpaved']
        ],
        layout: {
          'line-cap': 'round',
          'line-join': 'round'
        },
        paint: {
          'line-color': '#9c886b',
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 12, 1.1, 15, 3.4, 18, 9]
        }
      },

      // Asphalt Road Graphite Casings (#2b2b2b)
      {
        id: 'road-minor-casing',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        minzoom: 12,
        filter: [
          'all',
          ['!=', ['get', 'surface'], 'unpaved'],
          [
            'in',
            ['get', 'class'],
            ['literal', ['minor', 'street', 'unclassified', 'residential', 'living_street']]
          ]
        ],
        layout: {
          'line-cap': 'round',
          'line-join': 'round'
        },
        paint: {
          'line-color': '#2b2b2b',
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 12, 2.3, 15, 6.2, 18, 14.5]
        }
      },
      {
        id: 'road-secondary-casing',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        minzoom: 10,
        filter: [
          'all',
          ['!=', ['get', 'surface'], 'unpaved'],
          ['in', ['get', 'class'], ['literal', ['secondary', 'tertiary']]]
        ],
        layout: {
          'line-cap': 'round',
          'line-join': 'round'
        },
        paint: {
          'line-color': '#2b2b2b',
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 10, 2.8, 14, 8, 18, 20]
        }
      },
      {
        id: 'road-major-casing',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        minzoom: 8,
        filter: [
          'all',
          ['!=', ['get', 'surface'], 'unpaved'],
          ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary']]]
        ],
        layout: {
          'line-cap': 'round',
          'line-join': 'round'
        },
        paint: {
          'line-color': '#2b2b2b',
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 8, 3, 14, 10.6, 18, 25]
        }
      },

      // Deep Black Asphalt Road Fills (#121212)
      {
        id: 'road-minor-fill',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        minzoom: 12,
        filter: [
          'all',
          ['!=', ['get', 'surface'], 'unpaved'],
          [
            'in',
            ['get', 'class'],
            ['literal', ['minor', 'street', 'unclassified', 'residential', 'living_street']]
          ]
        ],
        layout: {
          'line-cap': 'round',
          'line-join': 'round'
        },
        paint: {
          'line-color': '#121212',
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 12, 1.3, 15, 4.4, 18, 12]
        }
      },
      {
        id: 'road-secondary-fill',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        minzoom: 10,
        filter: [
          'all',
          ['!=', ['get', 'surface'], 'unpaved'],
          ['in', ['get', 'class'], ['literal', ['secondary', 'tertiary']]]
        ],
        layout: {
          'line-cap': 'round',
          'line-join': 'round'
        },
        paint: {
          'line-color': '#121212',
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 10, 1.6, 14, 6, 18, 17]
        }
      },
      {
        id: 'road-major-fill',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        minzoom: 8,
        filter: [
          'all',
          ['!=', ['get', 'surface'], 'unpaved'],
          ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary']]]
        ],
        layout: {
          'line-cap': 'round',
          'line-join': 'round'
        },
        paint: {
          'line-color': '#121212',
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 8, 1.8, 14, 8.5, 18, 22]
        }
      },

      // Route Line (Bold GTA Yellow #ffcc00 with Black Outline)
      {
        id: 'route-casing',
        type: 'line',
        source: 'route',
        layout: {
          'line-cap': 'round',
          'line-join': 'round'
        },
        paint: {
          'line-color': '#080808',
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 7, 14, 12, 18, 18]
        }
      },
      {
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
          visibility: 'visible'
        },
        paint: {
          'line-color': '#ffcc00',
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 14, 7.2, 18, 11.5]
        }
      },
      {
        id: 'route-line-dashed',
        type: 'line',
        source: 'route',
        layout: {
          'line-cap': 'butt',
          'line-join': 'round',
          visibility: 'none'
        },
        paint: {
          'line-color': '#ffcc00',
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 14, 7.2, 18, 11.5],
          'line-dasharray': [2.2, 1.6]
        }
      },

      // 3D Buildings (#9c9c9c mid-gray for sharp contrast on #eaeaea blocks in 2D and 3D)
      {
        id: 'building-3d',
        type: 'fill-extrusion',
        source: 'openmaptiles',
        'source-layer': 'building',
        minzoom: 12,
        filter: ['!=', ['get', 'hide_3d'], true],
        paint: {
          'fill-extrusion-color': '#9c9c9c',
          'fill-extrusion-height': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            0,
            12.6,
            ['coalesce', ['get', 'render_height'], 12]
          ],
          'fill-extrusion-base': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            0,
            12.6,
            ['coalesce', ['get', 'render_min_height'], 0]
          ],
          'fill-extrusion-opacity': 0.96,
          'fill-extrusion-vertical-gradient': true
        }
      },

      // GTA SA Square Radar Blips (Fuel, Car Service, Food) at zoom >= 13
      {
        id: 'poi-blips',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'poi',
        minzoom: 13,
        filter: [
          'all',
          ['==', ['geometry-type'], 'Point'],
          [
            'in',
            ['get', 'class'],
            [
              'literal',
              ['fuel', 'car_repair', 'car_wash', 'car', 'cafe', 'restaurant', 'fast_food', 'food_court']
            ]
          ]
        ],
        layout: {
          'icon-image': [
            'match',
            ['get', 'class'],
            'fuel',
            'blip-fuel',
            ['car_repair', 'car_wash', 'car'],
            'blip-service',
            'blip-food'
          ],
          'icon-size': 1,
          'icon-padding': 6,
          'icon-allow-overlap': false,
          'symbol-sort-key': [
            'match',
            ['get', 'class'],
            'fuel',
            1,
            ['car_repair', 'car_wash', 'car'],
            2,
            3
          ]
        }
      },

      // Clean Readable Labels: White with #111111 halo (1.5px)
      {
        id: 'water-labels',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'water_name',
        minzoom: 9,
        layout: {
          'text-field': ['coalesce', ['get', 'name:ru'], ['get', 'name']],
          'text-font': FONT_MEDIUM,
          'text-size': ['interpolate', ['linear'], ['zoom'], 9, 12, 14, 15],
          'text-letter-spacing': 0.12
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#111111',
          'text-halo-width': 1.5
        }
      },
      {
        id: 'road-labels-major',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'transportation_name',
        minzoom: 11.5,
        filter: [
          'in',
          ['get', 'class'],
          ['literal', ['motorway', 'trunk', 'primary', 'secondary', 'tertiary']]
        ],
        layout: {
          'symbol-placement': 'line',
          'text-field': ['coalesce', ['get', 'name:ru'], ['get', 'name']],
          'text-font': FONT_MEDIUM,
          'text-size': ['interpolate', ['linear'], ['zoom'], 11.5, 10.5, 16, 13.5],
          'text-max-angle': 32,
          'symbol-spacing': 260
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#111111',
          'text-halo-width': 1.5
        }
      },
      {
        id: 'road-labels-streets',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'transportation_name',
        minzoom: 14,
        filter: [
          'in',
          ['get', 'class'],
          ['literal', ['minor', 'street', 'residential', 'unclassified']]
        ],
        layout: {
          'symbol-placement': 'line',
          'text-field': ['coalesce', ['get', 'name:ru'], ['get', 'name']],
          'text-font': FONT_REGULAR,
          'text-size': ['interpolate', ['linear'], ['zoom'], 14, 10, 17, 12.5],
          'text-max-angle': 30,
          'symbol-spacing': 280
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#111111',
          'text-halo-width': 1.5
        }
      },
      {
        id: 'peak-labels',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'mountain_peak',
        minzoom: 11.5,
        layout: {
          'text-field': [
            'concat',
            '▲ ',
            ['coalesce', ['get', 'name:ru'], ['get', 'name']]
          ],
          'text-font': FONT_MEDIUM,
          'text-size': 11.5,
          'text-anchor': 'bottom',
          'text-offset': [0, -0.4]
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#111111',
          'text-halo-width': 1.5
        }
      },
      {
        id: 'place-labels-districts',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        minzoom: 10.5,
        filter: [
          'in',
          ['get', 'class'],
          ['literal', ['suburb', 'quarter', 'neighbourhood', 'locality', 'village', 'hamlet']]
        ],
        layout: {
          'text-field': ['coalesce', ['get', 'name:ru'], ['get', 'name']],
          'text-font': FONT_MEDIUM,
          'text-size': ['interpolate', ['linear'], ['zoom'], 10.5, 11.5, 14, 14],
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.08,
          'text-padding': 6
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#111111',
          'text-halo-width': 1.5
        }
      },
      {
        id: 'place-labels-city',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        minzoom: 7,
        filter: ['in', ['get', 'class'], ['literal', ['city', 'town']]],
        layout: {
          'text-field': ['coalesce', ['get', 'name:ru'], ['get', 'name']],
          'text-font': FONT_MEDIUM,
          'text-size': ['interpolate', ['linear'], ['zoom'], 8, 14, 13, 18],
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.1
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#111111',
          'text-halo-width': 1.5
        }
      }
    ]
  };
}
