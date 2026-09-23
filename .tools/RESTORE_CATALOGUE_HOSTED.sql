begin;
-- Restores the catalogue/supplier reference data exactly as migrations 0017 + 0020 seed it.
-- (Hosted sitestock-london was found EMPTY of all four tables on 2026-09-23.)
do $$
begin
  if (select count(*) from suppliers) > 0 or (select count(*) from supplier_branches) > 0
     or (select count(*) from products) > 0 or (select count(*) from product_variants) > 0 then
    raise exception 'catalogue tables are not empty - refusing to re-seed';
  end if;
end $$;
insert into suppliers (name, website) values
  ('Travis Perkins', 'travisperkins.co.uk'),
  ('Jewson', 'jewson.co.uk'),
  ('Selco', 'selcobw.com'),
  ('Wickes Trade', 'wickes.co.uk'),
  ('MKM Building Supplies', 'mkmbs.co.uk'),
  ('Buildbase', 'buildbase.co.uk');

insert into supplier_branches (supplier_id, catalogue_key, name, postcode, latitude, longitude) values
  ((select id from suppliers where name = 'Travis Perkins'),        'b1',  'London Wandsworth', 'SW18 4ES', 51.4571, -0.1998),
  ((select id from suppliers where name = 'Jewson'),                'b2',  'Manchester',        'M11 4AU',  53.4808, -2.1749),
  ((select id from suppliers where name = 'Selco'),                 'b3',  'Birmingham',        'B6 7DB',   52.4862, -1.8904),
  ((select id from suppliers where name = 'Wickes Trade'),          'b4',  'Leeds',             'LS10 1AB', 53.8008, -1.5491),
  ((select id from suppliers where name = 'Travis Perkins'),        'b5',  'Bristol',           'BS1 6XX',  51.4545, -2.5879),
  ((select id from suppliers where name = 'Jewson'),                'b6',  'Glasgow',           'G1 1AA',   55.8642, -4.2518),
  ((select id from suppliers where name = 'MKM Building Supplies'), 'b7',  'Liverpool',         'L1 8JQ',   53.4084, -2.9916),
  ((select id from suppliers where name = 'Selco'),                 'b8',  'Newcastle',         'NE1 7RU',  54.9783, -1.6178),
  ((select id from suppliers where name = 'Buildbase'),             'b9',  'Sheffield',         'S1 2HE',   53.3811, -1.4701),
  ((select id from suppliers where name = 'Jewson'),                'b10', 'Nottingham',        'NG1 6HA',  52.9548, -1.1581),
  ((select id from suppliers where name = 'Travis Perkins'),        'b11', 'Cardiff',           'CF10 1EP', 51.4816, -3.1791),
  ((select id from suppliers where name = 'Buildbase'),             'b12', 'Edinburgh',         'EH1 1AA',  55.9533, -3.1883);

insert into products (catalogue_key, name, category, unit, unit_price, keywords, branch_ids) values
  ('p1',  'Treated Timber Fence Post', 'Timber',              'each',   8.50,  array['post','fence','wood','timber'],           array['b1','b2','b4','b5','b9']),
  ('p2',  'Rebar Reinforcement Bar',   'Building Materials',  'length', 6.20,  array['rebar','steel','reinforcement','concrete'], array['b1','b3','b6','b8']),
  ('p3',  'General Purpose Cement',    'Building Materials',  'bag',    6.75,  array['cement','concrete','mortar'],             array['b1','b2','b3','b4','b5','b6','b7','b8','b9','b10','b11','b12']),
  ('p4',  'Building Sand',             'Aggregates',          'bag',    4.50,  array['sand','aggregate','ballast'],             array['b1','b3','b5','b7','b9','b11']),
  ('p5',  'Plasterboard',              'Building Materials',  'sheet',  9.20,  array['plasterboard','drywall','gypsum'],        array['b1','b2','b4','b6','b10']),
  ('p6',  'Loft Insulation Roll',      'Insulation',          'roll',   22.00, array['insulation','loft','mineral wool'],       array['b2','b4','b6','b8','b10','b12']),
  ('p7',  'OSB3 Board',                'Timber',              'sheet',  14.50, array['osb','board','sheathing','wood'],         array['b1','b3','b5','b7','b9']),
  ('p8',  'Wood Screws',               'Fixings & Fasteners', 'box',    5.30,  array['screws','fixings','fasteners'],           array['b1','b2','b3','b4','b5','b6','b7','b8','b9','b10','b11','b12']),
  ('p9',  'Concrete Blocks',           'Building Materials',  'each',   1.35,  array['block','concrete block','blockwork'],     array['b1','b2','b3','b4','b5']),
  ('p10', 'Concrete Roof Tiles',       'Roofing',             'each',   1.10,  array['roof','tile','roofing'],                  array['b3','b5','b7','b9','b11']),
  ('p11', 'Hi-Vis Safety Vest',        'PPE',                 'each',   3.25,  array['hi-vis','vest','ppe','safety'],           array['b1','b2','b3','b4','b5','b6','b7','b8','b9','b10','b11','b12']),
  ('p12', 'Safety Helmet',             'PPE',                 'each',   7.80,  array['helmet','hard hat','ppe','safety'],       array['b1','b2','b3','b4','b5','b6','b7','b8','b9','b10','b11','b12']),
  ('p13', 'Copper Pipe',               'Plumbing',            'length', 11.40, array['pipe','copper','plumbing'],               array['b2','b4','b6','b8','b10']),
  ('p14', 'Cordless Combi Drill',      'Tools',               'each',   89.00, array['drill','tool','cordless','power tool'],   array['b1','b3','b5','b7','b9','b11']),
  ('p15', 'PVC Waste Pipe',            'Plumbing',            'length', 8.90,  array['pipe','pvc','waste','drainage'],          array['b1','b2','b3','b4','b5','b6']),
  ('p16', 'MDF Board',                 'Timber',              'sheet',  13.20, array['mdf','board','wood'],                     array['b2','b4','b6','b8']);

insert into product_variants (product_id, label, sort_order) values
  ((select id from products where catalogue_key = 'p1'), '75x75mm x 2.4m',   0),
  ((select id from products where catalogue_key = 'p1'), '100x100mm x 1.8m', 1),
  ((select id from products where catalogue_key = 'p1'), '100x100mm x 2.4m', 2),
  ((select id from products where catalogue_key = 'p1'), '100x100mm x 3.0m', 3),

  ((select id from products where catalogue_key = 'p2'), '8mm x 6m',  0),
  ((select id from products where catalogue_key = 'p2'), '10mm x 6m', 1),
  ((select id from products where catalogue_key = 'p2'), '12mm x 6m', 2),
  ((select id from products where catalogue_key = 'p2'), '10mm x 12m', 3),

  ((select id from products where catalogue_key = 'p3'), '10kg bag', 0),
  ((select id from products where catalogue_key = 'p3'), '25kg bag', 1),

  ((select id from products where catalogue_key = 'p4'), '25kg bag', 0),
  ((select id from products where catalogue_key = 'p4'), 'Bulk bag (~800kg)', 1),

  ((select id from products where catalogue_key = 'p5'), '2400x1200x9.5mm',  0),
  ((select id from products where catalogue_key = 'p5'), '2400x1200x12.5mm', 1),
  ((select id from products where catalogue_key = 'p5'), '3000x1200x12.5mm', 2),

  ((select id from products where catalogue_key = 'p6'), '100mm', 0),
  ((select id from products where catalogue_key = 'p6'), '150mm', 1),
  ((select id from products where catalogue_key = 'p6'), '200mm', 2),

  ((select id from products where catalogue_key = 'p7'), '9mm 2440x1220mm',  0),
  ((select id from products where catalogue_key = 'p7'), '11mm 2440x1220mm', 1),
  ((select id from products where catalogue_key = 'p7'), '18mm 2440x1220mm', 2),

  ((select id from products where catalogue_key = 'p8'), '4x40mm (Box of 200)',  0),
  ((select id from products where catalogue_key = 'p8'), '5x100mm (Box of 100)', 1),
  ((select id from products where catalogue_key = 'p8'), '6x120mm (Box of 50)',  2),

  ((select id from products where catalogue_key = 'p9'), '7N 440x215x100mm', 0),
  ((select id from products where catalogue_key = 'p9'), '7N 440x215x140mm', 1),
  ((select id from products where catalogue_key = 'p9'), '10N 440x215x100mm', 2),

  ((select id from products where catalogue_key = 'p10'), 'Interlocking - Slate Grey', 0),
  ((select id from products where catalogue_key = 'p10'), 'Interlocking - Terracotta', 1),
  ((select id from products where catalogue_key = 'p10'), 'Plain Tile - Red', 2),

  ((select id from products where catalogue_key = 'p11'), 'S', 0),
  ((select id from products where catalogue_key = 'p11'), 'M', 1),
  ((select id from products where catalogue_key = 'p11'), 'L', 2),
  ((select id from products where catalogue_key = 'p11'), 'XL', 3),

  ((select id from products where catalogue_key = 'p12'), 'White', 0),
  ((select id from products where catalogue_key = 'p12'), 'Yellow', 1),
  ((select id from products where catalogue_key = 'p12'), 'Orange', 2),
  ((select id from products where catalogue_key = 'p12'), 'Blue', 3),

  ((select id from products where catalogue_key = 'p13'), '15mm x 3m', 0),
  ((select id from products where catalogue_key = 'p13'), '22mm x 3m', 1),
  ((select id from products where catalogue_key = 'p13'), '28mm x 3m', 2),

  ((select id from products where catalogue_key = 'p14'), '18V - Body Only', 0),
  ((select id from products where catalogue_key = 'p14'), '18V - 1 Battery Kit', 1),
  ((select id from products where catalogue_key = 'p14'), '18V - 2 Battery Kit', 2),

  ((select id from products where catalogue_key = 'p15'), '32mm x 3m',  0),
  ((select id from products where catalogue_key = 'p15'), '40mm x 3m',  1),
  ((select id from products where catalogue_key = 'p15'), '110mm x 3m', 2),

  ((select id from products where catalogue_key = 'p16'), '12mm 2440x1220mm', 0),
  ((select id from products where catalogue_key = 'p16'), '18mm 2440x1220mm', 1),
  ((select id from products where catalogue_key = 'p16'), '25mm 2440x1220mm', 2);
commit;
select (select count(*) from suppliers) suppliers, (select count(*) from supplier_branches) branches, (select count(*) from products) products, (select count(*) from product_variants) variants;
