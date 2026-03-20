import sanitize = require('sanitize-html');

const OPTIONS: sanitize.IOptions = {
  allowedTags: ['p', 'br', 'strong', 'b', 'a'],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  /** URLs relativas / sem esquema (ex. `page` ou `./x`) são aceites pelo sanitize-html; não forçar `span`. */
  allowProtocolRelative: true,
  transformTags: {
    a: (_tagName, attribs) => {
      const href = (attribs.href || '').replace(/[\x00-\x20]+/g, '');
      const openInNewTab =
        /^https?:\/\//i.test(href) || /^[/\\]{2}/.test(href);
      if (openInNewTab) {
        return {
          tagName: 'a',
          attribs: {
            ...attribs,
            rel: 'noopener noreferrer',
            target: '_blank',
          },
        };
      }
      return { tagName: 'a', attribs };
    },
  },
};

export function sanitizeEventNotificationHtml(dirty: string): string {
  return sanitize(dirty, OPTIONS);
}

export function plainTextFromHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
