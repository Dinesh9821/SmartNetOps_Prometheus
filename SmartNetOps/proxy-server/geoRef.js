"use strict";

/**
 * Coordinate fallbacks, best-effort and offline.
 *
 * WHY THIS EXISTS
 *   /proxy1 returns "ID | Street | City | State | Country | Postcode".
 *   It carries no latitude or longitude, and sites.json has none either.
 *   Google Maps needs coordinates, so they have to come from somewhere.
 *
 * RESOLUTION ORDER (see siteGeoService.js)
 *   1. site-coords.json      -- authoritative, hand-supplied or cached
 *   2. Google Geocoding API  -- only if GOOGLE_MAPS_SERVER_KEY is set
 *   3. US state centroid     -- 212 of 324 sites are US, so this matters
 *   4. Country centroid      -- always available
 *
 * A centroid is an approximation. Every marker carries `precision` so the UI
 * can say so rather than implying a surveyed position.
 */

/* Country centroids for every country present in sites.json, plus the
   common neighbours so an unexpected site still lands somewhere sane. */
const COUNTRY = {
  "Mexico":            [23.6345, -102.5528],
  "United States":     [39.8283,  -98.5795],
  "Canada":            [56.1304, -106.3468],
  "Brazil":            [-14.2350, -51.9253],
  "Malaysia":          [4.2105,   101.9758],
  "New Zealand":       [-40.9006, 174.8860],
  "Singapore":         [1.3521,   103.8198],
  "Taiwan":            [23.6978,  120.9605],
  "Thailand":          [15.8700,  100.9925],
  "Vietnam":           [14.0583,  108.2772],
  "Vietnam(inactive)": [14.0583,  108.2772],
  "China":             [35.8617,  104.1954],
  "India":             [20.5937,   78.9629],
  "Japan":             [36.2048,  138.2529],
  "Australia":         [-25.2744, 133.7751],
  "Korea, Republic of":[35.9078,  127.7669],
  "South Korea":       [35.9078,  127.7669],
  "Indonesia":         [-0.7893,  113.9213],
  "Philippines":       [12.8797,  121.7740],
  "Hong Kong":         [22.3193,  114.1694],
  "Netherlands":       [52.1326,    5.2913],
  "Norway":            [60.4720,    8.4689],
  "Poland":            [51.9194,   19.1451],
  "Portugal":          [39.3999,   -8.2245],
  "Qatar":             [25.3548,   51.1839],
  "Romania":           [45.9432,   24.9668],
  "Saudi Arabia":      [23.8859,   45.0792],
  "Serbia":            [44.0165,   21.0059],
  "Slovakia":          [48.6690,   19.6990],
  "Slovenia":          [46.1512,   14.9955],
  "Sweden":            [60.1282,   18.6435],
  "Turkey":            [38.9637,   35.2433],
  "Ukraine":           [48.3794,   31.1656],
  "United Kingdom":    [55.3781,   -3.4360],
  "Germany":           [51.1657,   10.4515],
  "France":            [46.2276,    2.2137],
  "Spain":             [40.4637,   -3.7492],
  "Italy":             [41.8719,   12.5674],
  "Ireland":           [53.4129,   -8.2439],
  "Belgium":           [50.5039,    4.4699],
  "Switzerland":       [46.8182,    8.2275],
  "Austria":           [47.5162,   14.5501],
  "Czechia":           [49.8175,   15.4730],
  "Czech Republic":    [49.8175,   15.4730],
  "Hungary":           [47.1625,   19.5033],
  "Denmark":           [56.2639,    9.5018],
  "Finland":           [61.9241,   25.7482],
  "Greece":            [39.0742,   21.8243],
  "Bulgaria":          [42.7339,   25.4858],
  "Croatia":           [45.1000,   15.2000],
  "Israel":            [31.0461,   34.8516],
  "United Arab Emirates":[23.4241, 53.8478],
  "Egypt":             [26.8206,   30.8025],
  "South Africa":      [-30.5595,  22.9375],
  "Morocco":           [31.7917,   -7.0926],
  "Argentina":         [-38.4161, -63.6167],
  "Chile":             [-35.6751, -71.5430],
  "Colombia":          [4.5709,   -74.2973],
  "Peru":              [-9.1900,  -75.0152],
  "Costa Rica":        [9.7489,   -83.7534],
  "Panama":            [8.5380,   -80.7821]
};

/* Two-letter site-ID prefix -> country, mirroring sites.json prefix_country.
   Lets an unknown site still be placed from its ID alone. */
const PREFIX_COUNTRY = {
  MX: "Mexico", MY: "Malaysia", NL: "Netherlands", NO: "Norway",
  NZ: "New Zealand", PL: "Poland", PT: "Portugal", QA: "Qatar",
  RO: "Romania", RS: "Serbia", SA: "Saudi Arabia", SE: "Sweden",
  SG: "Singapore", SK: "Slovakia", SL: "Slovenia", TH: "Thailand",
  TR: "Turkey", TW: "Taiwan", UA: "Ukraine", US: "United States",
  VN: "Vietnam(inactive)", CA: "Canada", BR: "Brazil", CN: "China",
  IN: "India", JP: "Japan", AU: "Australia", KR: "South Korea",
  ID: "Indonesia", PH: "Philippines", HK: "Hong Kong",
  GB: "United Kingdom", UK: "United Kingdom", DE: "Germany",
  FR: "France", ES: "Spain", IT: "Italy", IE: "Ireland",
  BE: "Belgium", CH: "Switzerland", AT: "Austria", CZ: "Czechia",
  HU: "Hungary", DK: "Denmark", FI: "Finland", GR: "Greece",
  BG: "Bulgaria", HR: "Croatia", IL: "Israel", AE: "United Arab Emirates",
  EG: "Egypt", ZA: "South Africa", MA: "Morocco", AR: "Argentina",
  CL: "Chile", CO: "Colombia", PE: "Peru", CR: "Costa Rica", PA: "Panama"
};

const COUNTRY_REGION = {
  "Mexico": "AMER", "United States": "AMER", "Canada": "AMER",
  "Brazil": "AMER", "Argentina": "AMER", "Chile": "AMER",
  "Colombia": "AMER", "Peru": "AMER", "Costa Rica": "AMER", "Panama": "AMER",
  "Malaysia": "APAC", "New Zealand": "APAC", "Singapore": "APAC",
  "Taiwan": "APAC", "Thailand": "APAC", "Vietnam": "APAC",
  "Vietnam(inactive)": "APAC", "India": "APAC", "Japan": "APAC",
  "Australia": "APAC", "South Korea": "APAC", "Indonesia": "APAC",
  "Philippines": "APAC", "Hong Kong": "APAC",
  "China": "CHINA",
  "Netherlands": "EMEA", "Norway": "EMEA", "Poland": "EMEA",
  "Portugal": "EMEA", "Qatar": "EMEA", "Romania": "EMEA",
  "Saudi Arabia": "EMEA", "Serbia": "EMEA", "Slovakia": "EMEA",
  "Slovenia": "EMEA", "Sweden": "EMEA", "Turkey": "EMEA",
  "Ukraine": "EMEA", "United Kingdom": "EMEA", "Germany": "EMEA",
  "France": "EMEA", "Spain": "EMEA", "Italy": "EMEA", "Ireland": "EMEA",
  "Belgium": "EMEA", "Switzerland": "EMEA", "Austria": "EMEA",
  "Czechia": "EMEA", "Hungary": "EMEA", "Denmark": "EMEA",
  "Finland": "EMEA", "Greece": "EMEA", "Bulgaria": "EMEA",
  "Croatia": "EMEA", "Israel": "EMEA", "United Arab Emirates": "EMEA",
  "Egypt": "EMEA", "South Africa": "EMEA", "Morocco": "EMEA"
};

/* US state centroids — 212 of 324 sites are US, so state precision is
   the difference between a useful map and one big dot over Kansas. */
const US_STATE = {
  AL: [32.806671, -86.791130], AK: [61.370716, -152.404419],
  AZ: [33.729759, -111.431221], AR: [34.969704,  -92.373123],
  CA: [36.116203, -119.681564], CO: [39.059811, -105.311104],
  CT: [41.597782,  -72.755371], DE: [39.318523,  -75.507141],
  DC: [38.897438,  -77.026817], FL: [27.766279,  -81.686783],
  GA: [33.040619,  -83.643074], HI: [21.094318, -157.498337],
  ID: [44.240459, -114.478828], IL: [40.349457,  -88.986137],
  IN: [39.849426,  -86.258278], IA: [42.011539,  -93.210526],
  KS: [38.526600,  -96.726486], KY: [37.668140,  -84.670067],
  LA: [31.169546,  -91.867805], ME: [44.693947,  -69.381927],
  MD: [39.063946,  -76.802101], MA: [42.230171,  -71.530106],
  MI: [43.326618,  -84.536095], MN: [45.694454,  -93.900192],
  MS: [32.741646,  -89.678696], MO: [38.456085,  -92.288368],
  MT: [46.921925, -110.454353], NE: [41.125370,  -98.268082],
  NV: [38.313515, -117.055374], NH: [43.452492,  -71.563896],
  NJ: [40.298904,  -74.521011], NM: [34.840515, -106.248482],
  NY: [42.165726,  -74.948051], NC: [35.630066,  -79.806419],
  ND: [47.528912, -99.784012],  OH: [40.388783,  -82.764915],
  OK: [35.565342,  -96.928917], OR: [44.572021, -122.070938],
  PA: [40.590752,  -77.209755], RI: [41.680893,  -71.511780],
  SC: [33.856892,  -80.945007], SD: [44.299782,  -99.438828],
  TN: [35.747845,  -86.692345], TX: [31.054487,  -97.563461],
  UT: [40.150032, -111.862434], VT: [44.045876,  -72.710686],
  VA: [37.769337,  -78.169968], WA: [47.400902, -121.490494],
  WV: [38.491226,  -80.954453], WI: [44.268543,  -89.616508],
  WY: [42.755966, -107.302490], PR: [18.220833,  -66.590149]
};

const US_STATE_NAME = {
  "alabama":"AL","alaska":"AK","arizona":"AZ","arkansas":"AR","california":"CA",
  "colorado":"CO","connecticut":"CT","delaware":"DE","district of columbia":"DC",
  "florida":"FL","georgia":"GA","hawaii":"HI","idaho":"ID","illinois":"IL",
  "indiana":"IN","iowa":"IA","kansas":"KS","kentucky":"KY","louisiana":"LA",
  "maine":"ME","maryland":"MD","massachusetts":"MA","michigan":"MI",
  "minnesota":"MN","mississippi":"MS","missouri":"MO","montana":"MT",
  "nebraska":"NE","nevada":"NV","new hampshire":"NH","new jersey":"NJ",
  "new mexico":"NM","new york":"NY","north carolina":"NC","north dakota":"ND",
  "ohio":"OH","oklahoma":"OK","oregon":"OR","pennsylvania":"PA",
  "rhode island":"RI","south carolina":"SC","south dakota":"SD",
  "tennessee":"TN","texas":"TX","utah":"UT","vermont":"VT","virginia":"VA",
  "washington":"WA","west virginia":"WV","wisconsin":"WI","wyoming":"WY",
  "puerto rico":"PR"
};

/* Region centroids, for the map's "fly to region" control. */
const REGION_VIEW = {
  AMER:  { center: [ 19.0,  -85.0], zoom: 3 },
  EMEA:  { center: [ 46.0,   16.0], zoom: 4 },
  APAC:  { center: [  5.0,  120.0], zoom: 4 },
  CHINA: { center: [ 35.9,  104.2], zoom: 4 },
  GLOBAL:{ center: [ 20.0,    5.0], zoom: 2 }
};

module.exports = {
  COUNTRY, PREFIX_COUNTRY, COUNTRY_REGION,
  US_STATE, US_STATE_NAME, REGION_VIEW
};
