import ISO6391 from 'iso-639-1';

/**
 * Convert a human-readable subtitle language label to an ISO 639-1 code.
 *
 * Labels from subtitle services can include annotations such as
 * "English (US)", "Spanish [CC]", or already be a language code.
 */
export function labelToLanguageCode(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return '';

  const possibleCode = trimmed.toLowerCase().replace('_', '-').split('-')[0];
  if (ISO6391.validate(possibleCode)) return possibleCode;

  const withoutAnnotations = trimmed
    .replace(/\s*\[[^\]]*\]\s*/g, ' ')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .trim();

  const candidates = [
    trimmed,
    withoutAnnotations,
    withoutAnnotations.split(/\s[-|/]\s/)[0]?.trim(),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const code = ISO6391.getCode(candidate);
    if (code) return code;
  }

  return '';
}
