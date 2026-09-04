create table assets (
  code text primary key,
  name text not null,
  exponent int not null check (exponent between 0 and 18),
  kind text not null check (kind in ('fiat', 'crypto'))
);

insert into assets (code, name, exponent, kind) values
  ('GHS', 'Ghana cedi', 2, 'fiat'),
  ('HKD', 'Hong Kong dollar', 2, 'fiat'),
  ('USD', 'US dollar', 2, 'fiat'),
  ('USDT', 'Tether', 6, 'crypto'),
  ('BTC', 'Bitcoin', 8, 'crypto'),
  ('ETH', 'Ether', 8, 'crypto');
