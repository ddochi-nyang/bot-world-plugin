import type { AtmosphereMode, SoundMode, WeatherMode } from '../src/types.ts';
import { clearChildren, el } from './dom.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';

export type IconName =
  | 'paw'
  | 'building'
  | 'walk'
  | 'tv'
  | 'sun'
  | 'sunset'
  | 'moon'
  | 'contrast'
  | 'cloud'
  | 'cloud-sun'
  | 'rain'
  | 'snow'
  | 'sparkles'
  | 'volume-off'
  | 'volume-2'
  | 'bell'
  | 'music'
  | 'crosshair'
  | 'network'
  | 'map'
  | 'palette'
  | 'camera'
  | 'bar-chart'
  | 'eye'
  | 'eye-off'
  | 'globe'
  | 'play-circle'
  | 'help-circle'
  | 'refresh-cw'
  | 'clock'
  | 'coffee'
  | 'ball'
  | 'cookie'
  | 'swords';

type SvgShape =
  | { tag: 'path'; attrs: Record<string, string> }
  | { tag: 'circle'; attrs: Record<string, string> }
  | { tag: 'rect'; attrs: Record<string, string> }
  | { tag: 'line'; attrs: Record<string, string> }
  | { tag: 'polyline'; attrs: Record<string, string> }
  | { tag: 'polygon'; attrs: Record<string, string> };

const ICON_SHAPES: Readonly<Record<IconName, readonly SvgShape[]>> = Object.freeze({
  paw: [
    { tag: 'circle', attrs: { cx: '11', cy: '4', r: '1.8' } },
    { tag: 'circle', attrs: { cx: '18', cy: '8', r: '1.8' } },
    { tag: 'circle', attrs: { cx: '20', cy: '15', r: '1.8' } },
    { tag: 'circle', attrs: { cx: '5', cy: '8', r: '1.8' } },
    { tag: 'path', attrs: { d: 'M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.84 1.045Q6.52 17.48 4.46 16.84A3.5 3.5 0 0 1 5.5 10Z' } },
  ],
  building: [
    { tag: 'rect', attrs: { x: '4', y: '3', width: '16', height: '18', rx: '2' } },
    { tag: 'path', attrs: { d: 'M9 21v-4h6v4' } },
    { tag: 'path', attrs: { d: 'M8 7h2' } },
    { tag: 'path', attrs: { d: 'M14 7h2' } },
    { tag: 'path', attrs: { d: 'M8 11h2' } },
    { tag: 'path', attrs: { d: 'M14 11h2' } },
  ],
  walk: [
    { tag: 'circle', attrs: { cx: '13', cy: '4.5', r: '1.8' } },
    { tag: 'path', attrs: { d: 'M13.5 9.5 11 14l3 3 1 4' } },
    { tag: 'path', attrs: { d: 'm10 21 1.5-4.5-2-2.5 2-4.5 4 2 2.5 1.5' } },
    { tag: 'path', attrs: { d: 'm7.5 12 2.5-2.5' } },
  ],
  tv: [
    { tag: 'rect', attrs: { x: '2', y: '7', width: '20', height: '14', rx: '2' } },
    { tag: 'polyline', attrs: { points: '17 2 12 7 7 2' } },
  ],
  sun: [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '4' } },
    { tag: 'path', attrs: { d: 'M12 2v2' } },
    { tag: 'path', attrs: { d: 'M12 20v2' } },
    { tag: 'path', attrs: { d: 'm4.93 4.93 1.41 1.41' } },
    { tag: 'path', attrs: { d: 'm17.66 17.66 1.41 1.41' } },
    { tag: 'path', attrs: { d: 'M2 12h2' } },
    { tag: 'path', attrs: { d: 'M20 12h2' } },
    { tag: 'path', attrs: { d: 'm6.34 17.66-1.41 1.41' } },
    { tag: 'path', attrs: { d: 'm19.07 4.93-1.41 1.41' } },
  ],
  sunset: [
    { tag: 'path', attrs: { d: 'M12 10V3' } },
    { tag: 'path', attrs: { d: 'm4.93 10.93 1.41 1.41' } },
    { tag: 'path', attrs: { d: 'M2 18h20' } },
    { tag: 'path', attrs: { d: 'M6 18a6 6 0 0 1 12 0' } },
    { tag: 'path', attrs: { d: 'm17.66 12.34 1.41-1.41' } },
    { tag: 'path', attrs: { d: 'M7 21h10' } },
  ],
  moon: [
    { tag: 'path', attrs: { d: 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z' } },
  ],
  contrast: [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '9' } },
    { tag: 'path', attrs: { d: 'M12 3v18' } },
    { tag: 'path', attrs: { d: 'M12 8l5 4-5 4' } },
  ],
  cloud: [
    { tag: 'path', attrs: { d: 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z' } },
  ],
  'cloud-sun': [
    { tag: 'path', attrs: { d: 'M12 2v2' } },
    { tag: 'path', attrs: { d: 'm4.93 4.93 1.41 1.41' } },
    { tag: 'path', attrs: { d: 'M20 12h2' } },
    { tag: 'path', attrs: { d: 'm19.07 4.93-1.41 1.41' } },
    { tag: 'path', attrs: { d: 'M15.947 12.65a4 4 0 0 0-5.925-4.128' } },
    { tag: 'path', attrs: { d: 'M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z' } },
  ],
  rain: [
    { tag: 'path', attrs: { d: 'M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242' } },
    { tag: 'path', attrs: { d: 'm8 19-1 3' } },
    { tag: 'path', attrs: { d: 'm12 19-1 3' } },
    { tag: 'path', attrs: { d: 'm16 19-1 3' } },
  ],
  snow: [
    { tag: 'line', attrs: { x1: '2', y1: '12', x2: '22', y2: '12' } },
    { tag: 'line', attrs: { x1: '12', y1: '2', x2: '12', y2: '22' } },
    { tag: 'path', attrs: { d: 'm20 16-4-4 4-4' } },
    { tag: 'path', attrs: { d: 'm4 8 4 4-4 4' } },
    { tag: 'path', attrs: { d: 'm16 4-4 4-4-4' } },
    { tag: 'path', attrs: { d: 'm8 20 4-4 4 4' } },
  ],
  sparkles: [
    { tag: 'path', attrs: { d: 'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z' } },
    { tag: 'path', attrs: { d: 'M20 3v4' } },
    { tag: 'path', attrs: { d: 'M22 5h-4' } },
  ],
  'volume-off': [
    { tag: 'polygon', attrs: { points: '11 5 6 9 2 9 2 15 6 15 11 19 11 5' } },
    { tag: 'line', attrs: { x1: '22', y1: '9', x2: '16', y2: '15' } },
    { tag: 'line', attrs: { x1: '16', y1: '9', x2: '22', y2: '15' } },
  ],
  'volume-2': [
    { tag: 'polygon', attrs: { points: '11 5 6 9 2 9 2 15 6 15 11 19 11 5' } },
    { tag: 'path', attrs: { d: 'M15.54 8.46a5 5 0 0 1 0 7.07' } },
    { tag: 'path', attrs: { d: 'M19.07 4.93a10 10 0 0 1 0 14.14' } },
  ],
  bell: [
    { tag: 'path', attrs: { d: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9' } },
    { tag: 'path', attrs: { d: 'M10.3 21a1.94 1.94 0 0 0 3.4 0' } },
  ],
  music: [
    { tag: 'path', attrs: { d: 'M9 18V5l12-2v13' } },
    { tag: 'circle', attrs: { cx: '6', cy: '18', r: '3' } },
    { tag: 'circle', attrs: { cx: '18', cy: '16', r: '3' } },
  ],
  crosshair: [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '8' } },
    { tag: 'line', attrs: { x1: '22', y1: '12', x2: '18', y2: '12' } },
    { tag: 'line', attrs: { x1: '6', y1: '12', x2: '2', y2: '12' } },
    { tag: 'line', attrs: { x1: '12', y1: '6', x2: '12', y2: '2' } },
    { tag: 'line', attrs: { x1: '12', y1: '22', x2: '12', y2: '18' } },
  ],
  network: [
    { tag: 'circle', attrs: { cx: '18', cy: '5', r: '3' } },
    { tag: 'circle', attrs: { cx: '6', cy: '12', r: '3' } },
    { tag: 'circle', attrs: { cx: '18', cy: '19', r: '3' } },
    { tag: 'line', attrs: { x1: '8.59', y1: '13.51', x2: '15.42', y2: '17.49' } },
    { tag: 'line', attrs: { x1: '15.41', y1: '6.51', x2: '8.59', y2: '10.49' } },
  ],
  map: [
    { tag: 'polygon', attrs: { points: '3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21' } },
    { tag: 'line', attrs: { x1: '9', y1: '3', x2: '9', y2: '18' } },
    { tag: 'line', attrs: { x1: '15', y1: '6', x2: '15', y2: '21' } },
  ],
  palette: [
    { tag: 'circle', attrs: { cx: '13.5', cy: '6.5', r: '.8' } },
    { tag: 'circle', attrs: { cx: '17.5', cy: '10.5', r: '.8' } },
    { tag: 'circle', attrs: { cx: '8.5', cy: '7.5', r: '.8' } },
    { tag: 'circle', attrs: { cx: '6.5', cy: '12.5', r: '.8' } },
    { tag: 'path', attrs: { d: 'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2Z' } },
  ],
  camera: [
    { tag: 'path', attrs: { d: 'M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z' } },
    { tag: 'circle', attrs: { cx: '12', cy: '13', r: '3' } },
  ],
  'bar-chart': [
    { tag: 'line', attrs: { x1: '18', y1: '20', x2: '18', y2: '10' } },
    { tag: 'line', attrs: { x1: '12', y1: '20', x2: '12', y2: '4' } },
    { tag: 'line', attrs: { x1: '6', y1: '20', x2: '6', y2: '14' } },
  ],
  eye: [
    { tag: 'path', attrs: { d: 'M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0' } },
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '3' } },
  ],
  'eye-off': [
    { tag: 'path', attrs: { d: 'M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49' } },
    { tag: 'path', attrs: { d: 'M14.084 14.158a3 3 0 0 1-4.242-4.242' } },
    { tag: 'path', attrs: { d: 'M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143' } },
    { tag: 'path', attrs: { d: 'm2 2 20 20' } },
  ],
  globe: [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } },
    { tag: 'path', attrs: { d: 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20' } },
    { tag: 'path', attrs: { d: 'M2 12h20' } },
  ],
  'play-circle': [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } },
    { tag: 'polygon', attrs: { points: '10 8 16 12 10 16 10 8' } },
  ],
  'help-circle': [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } },
    { tag: 'path', attrs: { d: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3' } },
    { tag: 'path', attrs: { d: 'M12 17h.01' } },
  ],
  'refresh-cw': [
    { tag: 'path', attrs: { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' } },
    { tag: 'path', attrs: { d: 'M21 3v5h-5' } },
    { tag: 'path', attrs: { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' } },
    { tag: 'path', attrs: { d: 'M8 16H3v5' } },
  ],
  clock: [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } },
    { tag: 'polyline', attrs: { points: '12 6 12 12 16 14' } },
  ],
  coffee: [
    { tag: 'path', attrs: { d: 'M10 2v2' } },
    { tag: 'path', attrs: { d: 'M14 2v2' } },
    { tag: 'path', attrs: { d: 'M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1' } },
  ],
  ball: [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '9' } },
    { tag: 'path', attrs: { d: 'M5.6 5.6a9 9 0 0 0 0 12.8' } },
    { tag: 'path', attrs: { d: 'M18.4 5.6a9 9 0 0 1 0 12.8' } },
  ],
  cookie: [
    { tag: 'path', attrs: { d: 'M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5' } },
    { tag: 'path', attrs: { d: 'M8.5 8.5v.01' } },
    { tag: 'path', attrs: { d: 'M16 15.5v.01' } },
    { tag: 'path', attrs: { d: 'M12 12v.01' } },
    { tag: 'path', attrs: { d: 'M11 17v.01' } },
    { tag: 'path', attrs: { d: 'M7 14v.01' } },
  ],
  swords: [
    { tag: 'polyline', attrs: { points: '14.5 17.5 3 6 3 3 6 3 17.5 14.5' } },
    { tag: 'line', attrs: { x1: '13', y1: '19', x2: '19', y2: '13' } },
    { tag: 'line', attrs: { x1: '16', y1: '16', x2: '20', y2: '20' } },
    { tag: 'line', attrs: { x1: '19', y1: '21', x2: '21', y2: '19' } },
    { tag: 'polyline', attrs: { points: '14.5 6.5 18 3 21 3 21 6 17.5 9.5' } },
    { tag: 'line', attrs: { x1: '5', y1: '14', x2: '9', y2: '18' } },
    { tag: 'line', attrs: { x1: '7', y1: '17', x2: '4', y2: '20' } },
    { tag: 'line', attrs: { x1: '3', y1: '19', x2: '5', y2: '21' } },
  ],
});

function createSvgElement(tag: string): SVGElement {
  if (typeof document.createElementNS === 'function') {
    return document.createElementNS(SVG_NS, tag);
  }
  return document.createElement(tag) as unknown as SVGElement;
}

export function svgIcon(name: IconName, size = 14): SVGElement {
  const svg = createSvgElement('svg');
  svg.setAttribute('class', 'bw-svg-icon');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const shapes = ICON_SHAPES[name] ?? ICON_SHAPES['help-circle'];
  for (const shape of shapes) {
    const child = createSvgElement(shape.tag);
    for (const [k, v] of Object.entries(shape.attrs)) {
      child.setAttribute(k, v);
    }
    svg.appendChild(child);
  }
  return svg;
}

export function setButtonContent(
  btn: HTMLButtonElement,
  iconName: IconName | null,
  label?: string
): void {
  clearChildren(btn);
  if (iconName) {
    btn.appendChild(svgIcon(iconName, 14));
  }
  if (typeof label === 'string' && label.length > 0) {
    btn.appendChild(el('span', { className: 'bw-btn-label' }, label));
  }
}

export function atmosphereIconName(mode: AtmosphereMode): IconName {
  switch (mode) {
    case 'auto':
      return 'contrast';
    case 'day':
      return 'sun';
    case 'sunset':
      return 'sunset';
    case 'night':
      return 'moon';
  }
}

export function weatherIconName(mode: WeatherMode): IconName {
  switch (mode) {
    case 'auto':
      return 'cloud';
    case 'clear':
      return 'cloud-sun';
    case 'rain':
      return 'rain';
    case 'snow':
      return 'snow';
    case 'starlight':
      return 'sparkles';
  }
}

export function soundIconName(mode: SoundMode): IconName {
  switch (mode) {
    case 'off':
      return 'volume-off';
    case 'chimes':
      return 'bell';
    case 'ambient':
      return 'music';
  }
}
