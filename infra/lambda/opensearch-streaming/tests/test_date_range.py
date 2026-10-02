import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from date_range import date_ranges, interval, set_date_range  # noqa: E402


def days(value):
    found = interval(value)
    return found and (found[0].isoformat(), found[1].isoformat())


def span(first, last):
    return {'gte': first + 'T00:00:00.000Z', 'lte': last + 'T23:59:59.999Z'}


@pytest.mark.parametrize('value, first, last', [
    ('1886-09-22', '1886-09-22', '1886-09-22'),
    ('1886/09/22', '1886-09-22', '1886-09-22'),
    ('1886/9/2', '1886-09-02', '1886-09-02'),
    ('1886/09/22 10:15:00', '1886-09-22', '1886-09-22'),
    ('1886-09-22T10:15:00.000Z', '1886-09-22', '1886-09-22'),
    ('9/22/1886', '1886-09-22', '1886-09-22'),
    ('1999-06', '1999-06-01', '1999-06-30'),
    ('1999/06', '1999-06-01', '1999-06-30'),
    ('2000-02', '2000-02-01', '2000-02-29'),
    ('1963', '1963-01-01', '1963-12-31'),
    ('194X', '1940-01-01', '1949-12-31'),
    ('19XX', '1900-01-01', '1999-12-31'),
    ('July 1948', '1948-07-01', '1948-07-31'),
    ('May 20, 1959', '1959-05-20', '1959-05-20'),
    ('7999/10/10', '7999-10-10', '7999-10-10'),
    ('999/10/10', '0999-10-10', '0999-10-10'),
])
def test_a_date_covers_the_interval_of_its_precision(value, first, last):
    assert days(value) == (first, last)


@pytest.mark.parametrize('value', ['~1870', '1870~', '1870?', 'c. 1870', 'ca. 1870', 'circa 1870'])
def test_an_approximate_year_covers_that_year(value):
    assert days(value) == ('1870-01-01', '1870-12-31')


@pytest.mark.parametrize('value, first, last', [
    ('1960/1969', '1960-01-01', '1969-12-31'),
    ('1954-08-15/1954-08-18', '1954-08-15', '1954-08-18'),
    ('1989-04/1989-10', '1989-04-01', '1989-10-31'),
    ('1914~-1918~', '1914-01-01', '1918-12-31'),
    ('1914 - 1918', '1914-01-01', '1918-12-31'),
    ('1914 to 1918', '1914-01-01', '1918-12-31'),
])
def test_a_range_runs_from_the_start_of_the_first_date_to_the_end_of_the_last(value, first, last):
    assert days(value) == (first, last)


@pytest.mark.parametrize('value', [
    None, '', 'unknown', 'this is a string', '8.007007007', '1999-13', '1999-02-30', '13/1/1999', '0000',
    '1969/1960', 1963,
])
def test_a_value_that_is_not_a_date_has_no_interval(value):
    assert interval(value) is None


def test_start_and_end_dates_make_the_range():
    doc = {'start_date': '1940/06/03', 'end_date': '1949/06/03', 'date': ['1963']}
    assert date_ranges(doc) == [span('1940-06-03', '1949-06-03')]


def test_a_start_or_end_date_alone_covers_its_own_interval():
    assert date_ranges({'start_date': '1963'}) == [span('1963-01-01', '1963-12-31')]
    assert date_ranges({'end_date': '1963-05', 'date': ['1870']}) == [span('1963-05-01', '1963-05-31')]
    assert date_ranges({'start_date': '1963', 'end_date': 'unknown'}) == [span('1963-01-01', '1963-12-31')]


def test_date_is_used_when_there_is_no_start_or_end_date():
    doc = {'start_date': '', 'date': ['194X', 'unknown', '1886-09-22']}
    assert date_ranges(doc) == [span('1886-09-22', '1886-09-22'), span('1940-01-01', '1949-12-31')]
    assert date_ranges({'date': '1963'}) == [span('1963-01-01', '1963-12-31')]
    assert date_ranges({'date': {'1963'}}) == [span('1963-01-01', '1963-12-31')]


def test_a_start_date_after_the_end_date_has_no_range():
    assert date_ranges({'id': 'a1', 'start_date': '7999/10/10', 'end_date': '999/10/10', 'date': ['1963']}) == []


def test_a_document_without_dates_has_no_date_range_field():
    doc = {'id': 'a1', 'date_range': 'stale', 'date': ['unknown']}
    set_date_range(doc)
    assert doc == {'id': 'a1', 'date': ['unknown']}
    assert date_ranges({'date': None}) == []
