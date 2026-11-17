import { describe, expect, it } from 'vitest';
import { normalizeRapnetCsv, normalizeRapnetFeed, normalizeRapnetRecord, parseRapnetCsv } from './rapnetAdapter';

const apiRecord = {
  diamond_id: 987654321,
  stock_num: 'AB-102',
  shape: 'Round',
  size: 1.01,
  color: 'G',
  clarity: 'VS1',
  cut: 'Excellent',
  polish: 'Very Good',
  symmetry: 'EX',
  fluor_intensity: 'Strong Blue',
  lab: 'GIA',
  cert_num: 'GIA 2141438167',
  total_sales_price: 5252,
  currency_code: 'USD',
  depth_percent: 61.8,
  table_percent: 57,
  meas_length: 6.45,
  meas_width: 6.48,
  meas_depth: 3.99,
  girdle_min: 'Thin',
  girdle_max: 'Medium',
  image_file_url: 'http://cdn.example.com/a.jpg',
  video_url: '//v360.example.com/view/1',
  seller: { company: 'Acme Diamonds', account_id: 4411 },
  country: 'India',
};

describe('normalizeRapnetRecord', () => {
  it('maps an API record onto system enums', () => {
    const d = normalizeRapnetRecord(apiRecord);
    expect(d).toMatchObject({
      source: 'RAPNET',
      sourceStockId: '987654321',
      supplierName: 'Acme Diamonds',
      lab: 'GIA',
      certificateNumber: '2141438167',
      certificateUrl: 'https://www.gia.edu/report-check?reportno=2141438167',
      origin: 'NATURAL',
      shape: 'ROUND',
      color: 'G',
      clarity: 'VS1',
      cut: 'EXCELLENT',
      polish: 'VERY_GOOD',
      symmetry: 'EXCELLENT',
      fluorescence: 'STRONG',
      girdle: 'Thin - Medium',
      currency: 'USD',
      imageUrl: 'https://cdn.example.com/a.jpg',
      videoUrl: 'https://v360.example.com/view/1',
      locationCountry: 'IN',
      availability: 'AVAILABLE',
    });
    expect(d.carat.toString()).toBe('1.01');
    expect(d.wholesalePrice.toFixed(2)).toBe('5252.00');
    expect(d.pricePerCarat.toFixed(2)).toBe('5200.00');
    expect(d.lwRatio?.toFixed(2)).toBe('1.00');
    expect(d.depthPercent?.toString()).toBe('61.8');
  });

  it.each([
    ['color', 'd', 'D'],
    ['color', 'O-P', 'N_TO_Z'],
    ['color', 'Fancy Yellow', null],
    ['clarity', 'vvs 2', 'VVS2'],
    ['clarity', 'P1', 'I1'],
    ['clarity', 'bogus', null],
    ['cut', 'VG', 'VERY_GOOD'],
    ['cut', 'Ideal', 'IDEAL'],
    ['cut', '', null],
  ])('%s %j → %j', (field, input, expected) => {
    const d = normalizeRapnetRecord({ ...apiRecord, [field]: input });
    expect(d[field as 'color' | 'clarity' | 'cut']).toBe(expected);
  });

  it('derives total price from price per carat and detects lab-grown', () => {
    const d = normalizeRapnetRecord({
      'Stock #': 'LG-7',
      Shape: 'CU',
      Weight: '2.00',
      'Price Per Carat': '1,500.00',
      'Lab Grown': 'Yes',
      Lab: 'IGI',
      'Certificate #': 'LG 123456789',
    });
    expect(d.sourceStockId).toBe('unknown:LG-7');
    expect(d.origin).toBe('LAB_GROWN');
    expect(d.shape).toBe('CUSHION');
    expect(d.wholesalePrice.toFixed(2)).toBe('3000.00');
    expect(d.certificateNumber).toBe('LG123456789');
  });

  it('throws on unusable records', () => {
    expect(() => normalizeRapnetRecord({ shape: 'Round' })).toThrow(/diamond id/);
    expect(() => normalizeRapnetRecord({ ...apiRecord, size: 'n/a' })).toThrow(/carat/);
    expect(() => normalizeRapnetRecord({ ...apiRecord, total_sales_price: 0 })).toThrow(/price/);
  });
});

describe('CSV', () => {
  const csv =
    '﻿Stock #,Shape,Weight,Color,Clarity,Cut Grade,Total Price,Depth %,Table %,Measurements,Comments\r\n' +
    'S1,Oval,0.90,F,SI1,Very Good,"2,700.00",62.1,58,7.50 x 5.40 x 3.35,"Eye clean, ""no BGM"""\r\n' +
    'S2,Pear,,H,VS2,Good,1000,,,,\r\n';

  it('parses quoted fields and BOM', () => {
    const rows = parseRapnetCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.['Total Price']).toBe('2,700.00');
    expect(rows[0]?.Comments).toBe('Eye clean, "no BGM"');
  });

  it('normalises good rows and collects bad ones', () => {
    const { diamonds, rejected } = normalizeRapnetCsv(csv);
    expect(diamonds).toHaveLength(1);
    expect(diamonds[0]).toMatchObject({ shape: 'OVAL', color: 'F', clarity: 'SI1', cut: 'VERY_GOOD' });
    expect(diamonds[0]?.depthPercent?.toString()).toBe('62.1');
    expect(diamonds[0]?.depthMm?.toString()).toBe('3.35');
    expect(diamonds[0]?.lengthMm?.toString()).toBe('7.5');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatch(/carat/);
  });

  it('handles an empty feed', () => {
    expect(normalizeRapnetFeed([])).toEqual({ diamonds: [], rejected: [] });
  });
});
