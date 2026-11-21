/**
 * Secret and PII scrubbing utilities (ported from bot-world/src/orca/redact.rs
 * plus PEM Private Key header/block redaction).
 */

function isAsciiDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isAsciiUpper(code: number): boolean {
  return code >= 65 && code <= 90;
}

function isAsciiLower(code: number): boolean {
  return code >= 97 && code <= 122;
}

function isAsciiAlpha(code: number): boolean {
  return isAsciiUpper(code) || isAsciiLower(code);
}

function isAsciiAlnum(code: number): boolean {
  return isAsciiAlpha(code) || isAsciiDigit(code);
}

function isAsciiHex(code: number): boolean {
  return isAsciiDigit(code) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\v' || ch === '\f';
}

function isTokenBoundary(full: string, idx: number): boolean {
  if (idx === 0) return true;
  const prev = full.charCodeAt(idx - 1);
  return !(isAsciiAlnum(prev) || prev === 95); // '_'
}

function isEmailBoundary(full: string, idx: number): boolean {
  if (idx === 0) return true;
  const prev = full.charCodeAt(idx - 1);
  return !(
    isAsciiAlnum(prev) ||
    prev === 46 || // '.'
    prev === 95 || // '_'
    prev === 37 || // '%'
    prev === 43 || // '+'
    prev === 45 // '-'
  );
}

function isDigitBoundary(full: string, idx: number): boolean {
  if (idx === 0) return true;
  return !isAsciiAlnum(full.charCodeAt(idx - 1));
}

function isUuidTail(full: string, idx: number): boolean {
  if (idx < 24) return false;
  const start = idx - 24;
  if (start > 0 && isAsciiAlnum(full.charCodeAt(start - 1))) {
    return false;
  }
  if (
    full.charCodeAt(start + 8) !== 45 ||
    full.charCodeAt(start + 13) !== 45 ||
    full.charCodeAt(start + 18) !== 45 ||
    full.charCodeAt(start + 23) !== 45
  ) {
    return false;
  }
  for (let k = 0; k < 8; k++) {
    if (!isAsciiHex(full.charCodeAt(start + k))) return false;
  }
  for (let k = 9; k < 13; k++) {
    if (!isAsciiHex(full.charCodeAt(start + k))) return false;
  }
  for (let k = 14; k < 18; k++) {
    if (!isAsciiHex(full.charCodeAt(start + k))) return false;
  }
  for (let k = 19; k < 23; k++) {
    if (!isAsciiHex(full.charCodeAt(start + k))) return false;
  }
  return true;
}

function matchPemPrivateKey(rest: string): number | null {
  const m = /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.exec(rest);
  if (!m) return null;
  const headerLen = m[0].length;
  const tail = rest.slice(headerLen);
  const endMatch = /-----END [A-Z0-9 ]*PRIVATE KEY-----/.exec(tail);
  if (endMatch) {
    return headerLen + endMatch.index + endMatch[0].length;
  }
  // If END header is truncated, also consume subsequent Base64 body lines
  let pos = headerLen;
  while (pos < rest.length) {
    if (rest[pos] === '\r') pos++;
    if (rest[pos] === '\n') {
      pos++;
      const nextNl = rest.indexOf('\n', pos);
      const lineEnd = nextNl >= 0 ? nextNl : rest.length;
      const line = rest.slice(pos, lineEnd).replace(/\r$/, '').trim();
      if (line.length === 0) {
        pos = lineEnd;
        continue;
      }
      if (/^[A-Za-z0-9+/=]+$/.test(line)) {
        pos = lineEnd;
        continue;
      }
      break;
    }
    const nlIdx = rest.indexOf('\n', pos);
    if (nlIdx < 0) return rest.length;
    pos = nlIdx;
  }
  return pos;
}

function matchWebhookUrl(rest: string): number | null {
  if (rest.length <= 8 || rest.slice(0, 8).toLowerCase() !== 'https://') {
    return null;
  }
  let end = rest.length;
  for (let k = 8; k < rest.length; k++) {
    const ch = rest[k];
    if (
      isWhitespace(ch) ||
      ch === '"' ||
      ch === "'" ||
      ch === ')' ||
      ch === ']' ||
      ch === '>' ||
      ch === '`'
    ) {
      end = k;
      break;
    }
  }
  const url = rest.slice(8, end);
  let sepPos = -1;
  for (let k = 0; k < url.length; k++) {
    const c = url[k];
    if (c === '/' || c === '?' || c === '#') {
      sepPos = k;
      break;
    }
  }
  const rawAuthority = sepPos >= 0 ? url.slice(0, sepPos) : url;
  const atIdx = rawAuthority.lastIndexOf('@');
  const authority = atIdx >= 0 ? rawAuthority.slice(atIdx + 1) : rawAuthority;
  const path = sepPos >= 0 ? url.slice(sepPos) : '';
  const colonIdx = authority.indexOf(':');
  const host = (colonIdx >= 0 ? authority.slice(0, colonIdx) : authority).toLowerCase();

  const isSlack =
    host === 'hooks.slack.com' &&
    (path.startsWith('/services/') || path.startsWith('/triggers/')) &&
    path.length > '/services/'.length;
  const isDiscord =
    (host === 'discord.com' || host === 'discordapp.com') &&
    path.startsWith('/api/webhooks/') &&
    path.length > '/api/webhooks/'.length;
  const isTeamsWebhook =
    (host === 'webhook.office.com' || host.endsWith('.webhook.office.com')) && path.length > 1;
  const isOutlookWebhook =
    (host === 'outlook.office.com' || host === 'outlook.office365.com') &&
    path.startsWith('/webhook/') &&
    path.length > '/webhook/'.length;
  const isLogicAzure =
    (host === 'logic.azure.com' || host.endsWith('.logic.azure.com')) && path.length > 1;

  return isSlack || isDiscord || isTeamsWebhook || isOutlookWebhook || isLogicAzure ? end : null;
}

function matchUrlUserinfo(rest: string): { schemeLen: number; userinfoLen: number } | null {
  const lower8 = rest.slice(0, 8).toLowerCase();
  const lower7 = rest.slice(0, 7).toLowerCase();
  const schemeLen = lower8 === 'https://' ? 8 : lower7 === 'http://' ? 7 : 0;
  if (schemeLen === 0 || rest.length <= schemeLen) return null;

  let authEnd = rest.length;
  for (let k = schemeLen; k < rest.length; k++) {
    const ch = rest[k];
    if (
      isWhitespace(ch) ||
      ch === '/' ||
      ch === '?' ||
      ch === '#' ||
      ch === '"' ||
      ch === "'" ||
      ch === ')' ||
      ch === ']' ||
      ch === '>' ||
      ch === '`'
    ) {
      authEnd = k;
      break;
    }
  }
  const authority = rest.slice(schemeLen, authEnd);
  const atIdx = authority.indexOf('@');
  if (atIdx < 0) return null;
  const userinfo = authority.slice(0, atIdx);
  const host = authority.slice(atIdx + 1);
  if (!userinfo.includes(':') || userinfo.length < 3 || host.length === 0) {
    return null;
  }
  return { schemeLen, userinfoLen: atIdx };
}

function hasCredentialEntropy(token: string): boolean {
  let hasDigit = false;
  let hasUpper = false;
  let hasLower = false;
  let hasSymbol = false;
  for (let k = 0; k < token.length; k++) {
    const code = token.charCodeAt(k);
    if (isAsciiDigit(code)) hasDigit = true;
    else if (isAsciiUpper(code)) hasUpper = true;
    else if (isAsciiLower(code)) hasLower = true;
    else hasSymbol = true;
  }
  // Require digit/symbol or mixed case (not plain lowercase or capitalized English words)
  if (hasDigit || hasSymbol) return true;
  if (hasUpper && hasLower) {
    // Exclude simple Titlecase words like "Authentication"
    for (let k = 1; k < token.length; k++) {
      if (isAsciiUpper(token.charCodeAt(k))) return true;
    }
  }
  return false;
}

function matchAuthHeaderToken(rest: string): { totalLen: number; label: string } | null {
  const lower = rest.slice(0, 8).toLowerCase();
  let rawPrefixLen = 0;
  let label = '';
  let requireEntropy = false;

  if (lower.startsWith('bearer')) {
    rawPrefixLen = 6;
    label = 'Bearer';
  } else if (lower.startsWith('basic')) {
    rawPrefixLen = 5;
    label = 'Basic';
    requireEntropy = true;
  } else if (lower.startsWith('token')) {
    rawPrefixLen = 5;
    label = 'Token';
    requireEntropy = true;
  } else {
    return null;
  }

  let wsLen = 0;
  while (rawPrefixLen + wsLen < rest.length) {
    const ch = rest[rawPrefixLen + wsLen];
    if (ch === ' ' || ch === '\t') {
      wsLen++;
    } else {
      break;
    }
  }
  if (wsLen === 0) return null;

  const tokenStart = rawPrefixLen + wsLen;
  let tokenLen = 0;
  for (let k = tokenStart; k < rest.length; k++) {
    const code = rest.charCodeAt(k);
    if (
      isAsciiAlnum(code) ||
      code === 45 || // '-'
      code === 95 || // '_'
      code === 46 || // '.'
      code === 43 || // '+'
      code === 47 || // '/'
      code === 61 // '='
    ) {
      tokenLen++;
    } else {
      break;
    }
  }
  if (tokenLen < 8) return null;
  if (requireEntropy && !hasCredentialEntropy(rest.slice(tokenStart, tokenStart + tokenLen))) {
    return null;
  }
  return { totalLen: tokenStart + tokenLen, label };
}

const SLACK_PREFIXES = ['xoxb-', 'xoxp-', 'xoxa-', 'xoxr-', 'xoxs-', 'xoxe-', 'xapp-'] as const;
const GITHUB_PREFIXES = ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_'] as const;

function matchPrefixedToken(rest: string): number | null {
  if (rest.startsWith('AKIA') || rest.startsWith('ASIA')) {
    let len = 0;
    while (len < rest.length) {
      const code = rest.charCodeAt(len);
      if (isAsciiUpper(code) || isAsciiDigit(code)) {
        len++;
      } else {
        break;
      }
    }
    if (len === 20) return len;
  }

  for (const prefix of SLACK_PREFIXES) {
    if (rest.startsWith(prefix)) {
      let len = 0;
      while (len < rest.length) {
        const code = rest.charCodeAt(len);
        if (isAsciiAlnum(code) || code === 45 || code === 95) {
          len++;
        } else {
          break;
        }
      }
      if (len >= 14) return len;
    }
  }

  for (const prefix of GITHUB_PREFIXES) {
    if (rest.startsWith(prefix)) {
      let len = 0;
      while (len < rest.length) {
        const code = rest.charCodeAt(len);
        if (isAsciiAlnum(code) || code === 95) {
          len++;
        } else {
          break;
        }
      }
      if (len >= prefix.length + 16) return len;
    }
  }

  if (rest.startsWith('sk-ant-')) {
    let len = 0;
    while (len < rest.length) {
      const code = rest.charCodeAt(len);
      if (isAsciiAlnum(code) || code === 45 || code === 95) {
        len++;
      } else {
        break;
      }
    }
    if (len >= 20) return len;
  }

  if (rest.startsWith('sk-')) {
    let len = 0;
    while (len < rest.length) {
      const code = rest.charCodeAt(len);
      if (isAsciiAlnum(code) || code === 45 || code === 95) {
        len++;
      } else {
        break;
      }
    }
    if (len >= 18) return len;
  }

  if (rest.startsWith('AIza')) {
    let len = 0;
    while (len < rest.length) {
      const code = rest.charCodeAt(len);
      if (isAsciiAlnum(code) || code === 45 || code === 95) {
        len++;
      } else {
        break;
      }
    }
    if (len >= 24) return len;
  }

  if (rest.startsWith('glpat-')) {
    let len = 0;
    while (len < rest.length) {
      const code = rest.charCodeAt(len);
      if (isAsciiAlnum(code) || code === 45 || code === 95) {
        len++;
      } else {
        break;
      }
    }
    if (len >= 20) return len;
  }

  if (rest.startsWith('npm_')) {
    let len = 0;
    while (len < rest.length) {
      const code = rest.charCodeAt(len);
      if (isAsciiAlnum(code) || code === 95) {
        len++;
      } else {
        break;
      }
    }
    if (len >= 20) return len;
  }

  if (rest.startsWith('pypi-')) {
    let len = 0;
    while (len < rest.length) {
      const code = rest.charCodeAt(len);
      if (isAsciiAlnum(code) || code === 45 || code === 95) {
        len++;
      } else {
        break;
      }
    }
    if (len >= 21) return len;
  }

  return null;
}

function matchSeparatedCard(rest: string): number | null {
  let idx = 0;
  let sep: number | null = null;
  const groups: number[] = [];
  let curGroup = 0;
  let totalDigits = 0;

  while (idx < rest.length) {
    if (idx > 26) return null;
    const code = rest.charCodeAt(idx);
    if (isAsciiDigit(code)) {
      curGroup++;
      totalDigits++;
      if (totalDigits > 19) return null;
      idx++;
    } else if (code === 45 || code === 32) {
      // '-' or ' '
      if (curGroup === 0) break;
      if (sep !== null) {
        if (code !== sep) break;
      } else {
        sep = code;
      }
      if (idx + 1 >= rest.length || !isAsciiDigit(rest.charCodeAt(idx + 1))) {
        break;
      }
      groups.push(curGroup);
      curGroup = 0;
      idx++;
    } else {
      break;
    }
  }

  if (curGroup > 0) {
    groups.push(curGroup);
  }
  if (sep === null || groups.length < 3) return null;

  for (let g = 0; g < groups.length - 1; g++) {
    if (groups[g] < 3 || groups[g] > 6) return null;
  }
  const lastGroup = groups[groups.length - 1] ?? 0;
  if (lastGroup < 1 || lastGroup > 6) return null;

  if (totalDigits < 13 || totalDigits > 19) return null;

  if (idx < rest.length && isAsciiAlnum(rest.charCodeAt(idx))) {
    return null;
  }
  return idx;
}

function matchPaymentCard(rest: string): number | null {
  if (rest.length === 0 || !isAsciiDigit(rest.charCodeAt(0))) {
    return null;
  }
  const sepLen = matchSeparatedCard(rest);
  if (sepLen !== null) return sepLen;

  let digitLen = 0;
  while (digitLen < rest.length && isAsciiDigit(rest.charCodeAt(digitLen))) {
    digitLen++;
  }
  if (digitLen < 13 || digitLen > 19) return null;
  if (digitLen < rest.length && isAsciiAlnum(rest.charCodeAt(digitLen))) {
    return null;
  }
  if (digitLen === 13) {
    const first = rest.charCodeAt(0);
    if (first !== 51 && first !== 52 && first !== 53 && first !== 54) {
      return null;
    }
  }
  return digitLen;
}

function matchAwsAccountId(rest: string): number | null {
  let digitLen = 0;
  while (digitLen < rest.length && isAsciiDigit(rest.charCodeAt(digitLen))) {
    digitLen++;
  }
  if (digitLen !== 12) return null;
  if (rest.length > 12 && isAsciiAlnum(rest.charCodeAt(12))) {
    return null;
  }
  return 12;
}

function matchEmail(rest: string): number | null {
  let atPos = -1;
  for (let idx = 0; idx < rest.length; idx++) {
    const b = rest.charCodeAt(idx);
    if (b === 64) {
      // '@'
      if (idx === 0) return null;
      atPos = idx;
      break;
    }
    if (
      !(
        isAsciiAlnum(b) ||
        b === 46 ||
        b === 95 ||
        b === 37 ||
        b === 43 ||
        b === 45
      )
    ) {
      return null;
    }
    if (idx > 64) return null;
  }
  if (atPos < 0) return null;

  const domainPart = rest.slice(atPos + 1);
  let domainLen = 0;
  let hasDot = false;
  let lastDotPos = 0;

  for (let idx = 0; idx < domainPart.length; idx++) {
    const b = domainPart.charCodeAt(idx);
    if (b === 46) {
      if (idx === 0 || idx === lastDotPos + 1) return null;
      hasDot = true;
      lastDotPos = idx;
      domainLen = idx + 1;
    } else if (isAsciiAlnum(b) || b === 45) {
      domainLen = idx + 1;
    } else {
      break;
    }
    if (idx > 128) return null;
  }

  if (!hasDot || domainLen <= lastDotPos + 1) return null;
  const tldLen = domainLen - (lastDotPos + 1);
  if (tldLen < 2) return null;
  for (let k = lastDotPos + 1; k < domainLen; k++) {
    if (!isAsciiAlpha(domainPart.charCodeAt(k))) return null;
  }
  return atPos + 1 + domainLen;
}

export function scrubSecrets(input: string): string {
  if (!input) return '';
  let out = '';
  let i = 0;

  while (i < input.length) {
    const rest = input.slice(i);

    const pemLen = matchPemPrivateKey(rest);
    if (pemLen !== null) {
      out += '[REDACTED_PRIVATE_KEY]';
      i += pemLen;
      continue;
    }

    const webhookLen = matchWebhookUrl(rest);
    if (webhookLen !== null) {
      out += '[REDACTED_WEBHOOK]';
      i += webhookLen;
      continue;
    }

    const userinfoMatch = matchUrlUserinfo(rest);
    if (userinfoMatch !== null) {
      out += rest.slice(0, userinfoMatch.schemeLen) + '[REDACTED_TOKEN]';
      i += userinfoMatch.schemeLen + userinfoMatch.userinfoLen;
      continue;
    }

    if (isTokenBoundary(input, i)) {
      const authMatch = matchAuthHeaderToken(rest);
      if (authMatch !== null) {
        out += `${authMatch.label} [REDACTED_TOKEN]`;
        i += authMatch.totalLen;
        continue;
      }

      const tokenLen = matchPrefixedToken(rest);
      if (tokenLen !== null) {
        out += '[REDACTED_TOKEN]';
        i += tokenLen;
        continue;
      }
    }

    const cp = input.codePointAt(i) ?? 0;
    const chLen = cp > 0xffff ? 2 : 1;
    out += input.slice(i, i + chLen);
    i += chLen;
  }

  return out;
}

export function scrubPii(input: string): string {
  if (!input) return '';
  let out = '';
  let i = 0;

  while (i < input.length) {
    const rest = input.slice(i);

    if (isEmailBoundary(input, i)) {
      const emailLen = matchEmail(rest);
      if (emailLen !== null) {
        out += '[REDACTED_PII]';
        i += emailLen;
        continue;
      }
    }

    if (isDigitBoundary(input, i)) {
      const cardLen = matchPaymentCard(rest);
      if (cardLen !== null) {
        out += '[REDACTED_PII]';
        i += cardLen;
        continue;
      }
      if (!isUuidTail(input, i)) {
        const awsLen = matchAwsAccountId(rest);
        if (awsLen !== null) {
          out += '[REDACTED_PII]';
          i += awsLen;
          continue;
        }
      }
    }

    const cp = input.codePointAt(i) ?? 0;
    const chLen = cp > 0xffff ? 2 : 1;
    out += input.slice(i, i + chLen);
    i += chLen;
  }

  return out;
}

export function scrubAll(input: string): string {
  return scrubPii(scrubSecrets(input));
}

export function redactLabel(botName: string, statusLabel: string): string {
  return `${scrubAll(botName)} · ${statusLabel}`;
}
