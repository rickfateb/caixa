-- Fonte: planilha operacional Modelo_Pedidos_Mercadinho_Google_Sheets-1,
-- aba CARGAS_AUTO, siglas únicas encontradas em 27/09/2026.
-- Não altera unidades já cadastradas; IDs externos não foram informados pela fonte.
INSERT INTO units(name,acronym) VALUES
  ('The Wall II','TW'),('Villa Lobos','VL'),('Cerejeiras','CE'),
  ('GPTronics','GP'),('Caribe','CB'),('Acordes','AC'),('Argus','AR'),
  ('The Garden','TG'),('The Unique','TU'),('Alecrim','AL'),
  ('Capadócia','CP'),('Tokio','TK'),('Pekin','PK')
ON CONFLICT(acronym) DO NOTHING;
