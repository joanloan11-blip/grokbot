const PART =
  /^(\*|\d{1,2}(-\d{1,2})?)(\/\d{1,2})?(,(\*|\d{1,2}(-\d{1,2})?)(\/\d{1,2})?)*$/;

export function isValidCron(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const ranges: [number, number][] = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];
  return parts.every((part, index) => {
    const range = ranges[index];
    return range ? fieldValid(part, range[0], range[1]) : false;
  });
}

export function cronMatches(expression: string, date: Date): boolean {
  if (!isValidCron(expression)) return false;
  const [minute, hour, day, month, weekday] = expression.trim().split(/\s+/);
  const dow = date.getDay();
  return (
    matchField(minute ?? '*', date.getMinutes(), 0, 59) &&
    matchField(hour ?? '*', date.getHours(), 0, 23) &&
    matchField(day ?? '*', date.getDate(), 1, 31) &&
    matchField(month ?? '*', date.getMonth() + 1, 1, 12) &&
    (matchField(weekday ?? '*', dow, 0, 6) ||
      (dow === 0 && matchField(weekday ?? '*', 7, 0, 7)))
  );
}

function fieldValid(field: string, min: number, max: number): boolean {
  if (!PART.test(field)) return false;
  return field.split(',').every((piece) => pieceValid(piece, min, max));
}

function pieceValid(piece: string, min: number, max: number): boolean {
  const [base, stepRaw] = piece.split('/');
  if (!base) return false;
  if (stepRaw !== undefined) {
    const step = Number(stepRaw);
    if (!Number.isInteger(step) || step <= 0) return false;
  }
  if (base === '*') return true;
  if (base.includes('-')) {
    const [startRaw, endRaw] = base.split('-');
    const start = Number(startRaw);
    const end = Number(endRaw);
    return (
      Number.isInteger(start) &&
      Number.isInteger(end) &&
      start >= min &&
      end <= max &&
      start <= end
    );
  }
  const value = Number(base);
  return Number.isInteger(value) && value >= min && value <= max;
}

function matchField(
  field: string,
  value: number,
  min: number,
  max: number,
): boolean {
  return field.split(',').some((piece) => matchPiece(piece, value, min, max));
}

function matchPiece(
  piece: string,
  value: number,
  min: number,
  max: number,
): boolean {
  const [base, stepRaw] = piece.split('/');
  const step = stepRaw === undefined ? 1 : Number(stepRaw);
  if (!base || !Number.isInteger(step) || step <= 0) return false;
  let start = min;
  let end = max;
  if (base !== '*') {
    if (base.includes('-')) {
      const [startRaw, endRaw] = base.split('-');
      start = Number(startRaw);
      end = Number(endRaw);
    } else {
      start = Number(base);
      end = start;
    }
  }
  if (value < start || value > end) return false;
  return (value - start) % step === 0;
}
