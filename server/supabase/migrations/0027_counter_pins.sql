-- Each counter can have its own PIN, set by the Owner. Opening or closing a shift on that counter
-- asks for the PIN instead of the cashier's password. Only a salted scrypt hash is stored, never the PIN.
alter table public.counters add column pin_hash text;

notify pgrst, 'reload schema';
