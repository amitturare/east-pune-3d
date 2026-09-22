// Colour choices shared by the worker (ground texture, buildings) and the main thread.

// Ground texture colours per land-use class. Late-September Pune: post-monsoon, still green.
export const GROUND = {
  base: '#8a8a64',
  residential: '#a89f8c',
  commercial: '#aaa194',
  industrial: '#9d9990',
  military: '#7f8c5e',
  park: '#5f8c43',
  garden: '#679448',
  grass: '#7a954f',
  wood: '#44692f',
  scrub: '#737f4b',
  wetland: '#667f5f',
  farmland: '#97a05d',
  cemetery: '#83906a',
  railway: '#9b9186',
  construction: '#b19b7b',
  education: '#afa892',
  hospital: '#b5aa9c',
  parking: '#8d8a86',
  pitch: '#6c9d4f',
  golf: '#76a853',
  sand: '#c6b28b',
  aerodrome: '#98a46b',
  apron: '#8b8b88',
  runway: '#4f5256',
  taxiway: '#65686b',
  water: '#34504a',
};

// Probability (0..1) of a tree in each 6 m cell of a land-use class.
export const TREE_DENSITY = {
  base: 0.035, residential: 0.05, commercial: 0.02, industrial: 0.015, military: 0.14, park: 0.34, garden: 0.3,
  grass: 0.05, wood: 0.75, scrub: 0.16, wetland: 0.1, farmland: 0.01, cemetery: 0.22, railway: 0, construction: 0.005,
  education: 0.12, hospital: 0.08, parking: 0.02, pitch: 0, golf: 0.1, sand: 0, aerodrome: 0, apron: 0, runway: 0, taxiway: 0,
};

// Wall colours by building type (several options each, picked by a hash of the OSM id).
export const WALLS = {
  residential: ['#ece5d6', '#e8dcc4', '#f1ead9', '#e6d7c3', '#e9d2c1', '#ddd6cb', '#efe3c8', '#d9cfc0', '#e7c9b5'],
  house: ['#eadfca', '#e9c9a8', '#f0e4d0', '#dcc9b0', '#e7d3bd', '#d8b89a'],
  apartments: ['#efebe3', '#e6e1d6', '#ece3d2', '#dfdbd3', '#e9ddc9', '#e4e2dc'],
  commercial: ['#c9d1d6', '#b8c3cb', '#d6d7d3', '#a9b8c4', '#cfd3d4', '#e3e1da'],
  industrial: ['#b8b6ae', '#a9aaa4', '#c2beb2', '#9fa3a3'],
  education: ['#e2d3b8', '#dccbb0', '#e6dcc9', '#d4b69a'],
  religious: ['#f3eee4', '#efe0c4', '#e9d9bf'],
  palace: ['#e6d4b0'],
  station: ['#d8c9b3', '#cfc2b0'],
  small: ['#cdbfa9', '#bfb4a2', '#c9b79c', '#b7ab9a'],
};

export const ROOFS = ['#a39d93', '#9b968e', '#aca69b', '#948f87', '#b1aa9f', '#8f8a84', '#a8a092', '#9c8f80'];

export const CATEGORY = {
  neighbourhood: { color: '#ffffff', icon: '◎', label: 'Neighbourhood' },
  heritage: { color: '#f4b860', icon: '♜', label: 'Heritage' },
  transit: { color: '#39c6d6', icon: 'M', label: 'Transit' },
  airport: { color: '#8fb4ff', icon: '✈', label: 'Airport' },
  river: { color: '#6ec3ff', icon: '≈', label: 'River' },
  park: { color: '#7ed37a', icon: '❀', label: 'Park' },
  mall: { color: '#ff8fb1', icon: '◆', label: 'Shopping' },
  bridge: { color: '#d7b98e', icon: '⌒', label: 'Bridge' },
  road: { color: '#ffcf7a', icon: '═', label: 'Road' },
  religious: { color: '#ffb36b', icon: '✦', label: 'Place of worship' },
  education: { color: '#c59bff', icon: '✎', label: 'Education' },
  civic: { color: '#c7ced8', icon: '▣', label: 'Civic' },
  rail: { color: '#b6a0ff', icon: '⇌', label: 'Railway' },
};
