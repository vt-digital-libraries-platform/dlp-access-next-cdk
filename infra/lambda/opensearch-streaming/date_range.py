'''Derives the date_range search field from a document's date attributes.

Each date value is read as the interval it covers: a day, a month, a year, a
decade (194X), a century (19XX) or an explicit range (1960/1969). Approximate
markers (~, ?, c., ca., circa) are dropped and the value keeps the interval of
what is left. Values that don't parse are skipped.
'''
import calendar
import logging
import re
from datetime import date

logger = logging.getLogger()

DATE_RANGE_FIELD = 'date_range'

MONTHS = {name.lower(): number for number, name in enumerate(calendar.month_name) if name}
MONTHS.update({abbr.lower(): number for number, abbr in enumerate(calendar.month_abbr) if abbr})
MONTHS['sept'] = 9

APPROXIMATE_PREFIX = re.compile(r'^(?:circa|ca\.?|c\.?)\s*(?=\d)', re.IGNORECASE)
TIME_SUFFIX = r'(?:[T ]\d{1,2}:\d{2}\S*)?'
YEAR_MONTH_DAY = re.compile(r'^(\d{3,4})[-/](\d{1,2})[-/](\d{1,2})' + TIME_SUFFIX + '$')
MONTH_DAY_YEAR = re.compile(r'^(\d{1,2})/(\d{1,2})/(\d{4})$')
YEAR_MONTH = re.compile(r'^(\d{3,4})[-/](\d{1,2})$')
YEAR = re.compile(r'^(\d{4})$')
DECADE = re.compile(r'^(\d{3})X$', re.IGNORECASE)
CENTURY = re.compile(r'^(\d{2})XX$', re.IGNORECASE)
NAMED_MONTH_DAY_YEAR = re.compile(r'^([A-Za-z]+)\.? (\d{1,2}),? (\d{4})$')
NAMED_MONTH_YEAR = re.compile(r'^([A-Za-z]+)\.?,? (\d{4})$')
RANGE_SEPARATOR = re.compile(r'\s*(?:/|-|–|—|\bto\b)\s*')


def _day(year, month, day):
    return date(year, month, day), date(year, month, day)


def _month(year, month):
    return date(year, month, 1), date(year, month, calendar.monthrange(year, month)[1])


def _years(first, last):
    return date(first, 1, 1), date(last, 12, 31)


def _single(text):
    '''The (first day, last day) of one date value, or None.'''
    try:
        match = YEAR_MONTH_DAY.match(text)
        if match:
            return _day(*map(int, match.groups()))
        match = MONTH_DAY_YEAR.match(text)
        if match:
            month, day, year = map(int, match.groups())
            return _day(year, month, day)
        match = YEAR_MONTH.match(text)
        if match:
            return _month(*map(int, match.groups()))
        match = YEAR.match(text)
        if match:
            return _years(int(text), int(text))
        match = DECADE.match(text)
        if match:
            return _years(int(match.group(1)) * 10, int(match.group(1)) * 10 + 9)
        match = CENTURY.match(text)
        if match:
            return _years(int(match.group(1)) * 100, int(match.group(1)) * 100 + 99)
        match = NAMED_MONTH_DAY_YEAR.match(text)
        if match and match.group(1).lower() in MONTHS:
            return _day(int(match.group(3)), MONTHS[match.group(1).lower()], int(match.group(2)))
        match = NAMED_MONTH_YEAR.match(text)
        if match and match.group(1).lower() in MONTHS:
            return _month(int(match.group(2)), MONTHS[match.group(1).lower()])
    except ValueError:  # no such date, e.g. month 13 or year 0
        return None
    return None


def _clean(text):
    return APPROXIMATE_PREFIX.sub('', re.sub(r'[~?]', '', text).strip()).strip()


def interval(value):
    '''The (first day, last day) a date value covers, or None if it doesn't parse.'''
    if not isinstance(value, str):
        return None
    text = _clean(value)
    single = _single(text)
    if single:
        return single
    # A range: two dates around a separator. 1999/06 is a month, 1960/1969 a range.
    for separator in RANGE_SEPARATOR.finditer(text):
        first = _single(_clean(text[:separator.start()]))
        last = _single(_clean(text[separator.end():]))
        if first and last:
            return (first[0], last[1]) if first[0] <= last[1] else None
    return None


def _range(first, last):
    return {'gte': first.isoformat() + 'T00:00:00.000Z', 'lte': last.isoformat() + 'T23:59:59.999Z'}


def date_ranges(doc):
    '''The date_range values of a document: start_date to end_date, or else
    one range per value of date.'''
    start = interval(doc.get('start_date'))
    end = interval(doc.get('end_date'))
    if start or end:
        first, last = (start or end)[0], (end or start)[1]
        if first > last:
            logger.warning('start_date is after end_date, no %s for id=%s', DATE_RANGE_FIELD, doc.get('id'))
            return []
        return [_range(first, last)]

    dates = doc.get('date')
    if isinstance(dates, str):
        dates = [dates]
    if not isinstance(dates, (list, set, tuple)):
        return []
    intervals = sorted(found for found in map(interval, dates) if found)
    return [_range(first, last) for first, last in intervals]


def set_date_range(doc):
    '''Sets or clears the derived date_range field of a document, in place.'''
    ranges = date_ranges(doc)
    if ranges:
        doc[DATE_RANGE_FIELD] = ranges
    else:
        doc.pop(DATE_RANGE_FIELD, None)
