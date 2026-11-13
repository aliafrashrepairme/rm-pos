-- The first migration seeded the prototype's sample address, phone and VAT number.
-- They must not print on real receipts, so they are cleared unless someone has already changed them.
update public.store_settings set address = '' where address = 'Jaffna, Sri Lanka';
update public.store_settings set phone = '' where phone = '021 222 3344';
update public.store_settings set vat_registration = '' where vat_registration = '114 223 344-7000';
