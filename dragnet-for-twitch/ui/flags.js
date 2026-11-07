// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Rathinosk
//
// Small round flags for the language button: one representative flag per UI locale
// (English: United Kingdom; Spanish (Latin America): Mexico). Simplified shapes on a 20 x 20
// square, cropped to a circle by CSS (.flag). Built with DOM APIs, like the rest of the UI.

const SVG = 'http://www.w3.org/2000/svg';

const rect = (x, y, width, height, fill) => ['rect', { x, y, width, height, fill }];
const stripesH = (...fills) => fills.map((f, i) => rect(0, (20 / fills.length) * i, 20, 20 / fills.length, f));
const stripesV = (...fills) => fills.map((f, i) => rect((20 / fills.length) * i, 0, 20 / fills.length, 20, f));

const FLAGS = {
  gb: [
    rect(0, 0, 20, 20, '#012169'),
    ['path', { d: 'M0 0 20 20M20 0 0 20', stroke: '#fff', 'stroke-width': 4 }],
    ['path', { d: 'M0 0 20 20M20 0 0 20', stroke: '#c8102e', 'stroke-width': 1.4 }],
    rect(7, 0, 6, 20, '#fff'), rect(0, 7, 20, 6, '#fff'),
    rect(8.3, 0, 3.4, 20, '#c8102e'), rect(0, 8.3, 20, 3.4, '#c8102e'),
  ],
  de: stripesH('#000', '#dd0000', '#ffce00'),
  ru: stripesH('#fff', '#0039a6', '#d52b1e'),
  fr: stripesV('#002654', '#fff', '#ce1126'),
  es: [rect(0, 0, 20, 20, '#aa151b'), rect(0, 5, 20, 10, '#f1bf00')],
  mx: [...stripesV('#006847', '#fff', '#ce1126'), ['circle', { cx: 10, cy: 10, r: 2, fill: '#8c5a2b' }]],
  jp: [rect(0, 0, 20, 20, '#fff'), ['circle', { cx: 10, cy: 10, r: 5.5, fill: '#bc002d' }]],
  br: [
    rect(0, 0, 20, 20, '#009c3b'),
    ['path', { d: 'M10 2.5 18.5 10 10 17.5 1.5 10Z', fill: '#ffdf00' }],
    ['circle', { cx: 10, cy: 10, r: 4.2, fill: '#002776' }],
  ],
};

// Flag for a BCP 47 tag of a UI locale.
const BY_LANGUAGE = { en: 'gb', de: 'de', es: 'es', 'es-419': 'mx', fr: 'fr', ja: 'jp', 'pt-BR': 'br', ru: 'ru' };

/** A round flag (span.flag holding an SVG) for a language tag; a plain disc if none fits. */
export function flagIcon(lang) {
  const shapes = FLAGS[BY_LANGUAGE[lang] ?? BY_LANGUAGE[lang.split('-')[0]]] ?? [rect(0, 0, 20, 20, 'currentColor')];
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of shapes) {
    const node = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
    svg.append(node);
  }
  const span = document.createElement('span');
  span.className = 'flag';
  span.append(svg);
  return span;
}
