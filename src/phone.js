// Turns "98765 43210", "098765-43210", "91 9876543210", "+91 98765 43210" into "+919876543210".

export function normalizePhone(raw, countryCode = '91') {
  if (!raw) return null;
  const text = String(raw).trim();
  let digits = text.replace(/\D/g, '');
  if (!digits) return null;

  if (text.startsWith('+')) {
    // already international
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else {
    digits = digits.replace(/^0+/, '');
    if (digits.length === 10) digits = countryCode + digits;
  }

  // "+91 0 98765..." style: drop the trunk zero after the country code
  if (digits.startsWith(countryCode + '0')) digits = countryCode + digits.slice(countryCode.length + 1);

  if (digits.length < 10 || digits.length > 15) return null;
  return '+' + digits;
}
