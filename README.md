# Facinho Caixa · Portal de dados

Projeto independente do Cobile, destinado a alimentar o aplicativo de frente de caixa desenvolvido no Cursor. Implantação prevista em um **projeto Railway separado**, com PostgreSQL próprio. Não acessa os subdomínios nem o banco do Cobile em tempo de execução.

## Primeira versão

- Portal web em português com login Google e permissões de Administrador/Supervisor.
- Unidades, produtos, códigos de barras, preços por unidade, configurações e caixas.
- Cada caixa recebe um token exclusivo, apresentado apenas na criação, que identifica a unidade automaticamente.
- APIs para o app: `GET /api/v1/catalog`, `GET /api/v1/config`, `GET /api/v1/sync-state`, `POST /api/v1/sync-ack` e `POST /api/v1/sales`.
- A área **Mídias** recebe uploads, guarda os arquivos no PostgreSQL exclusivo do portal e serve JPGs padronizados. URLs HTTPS antigas continuam aceitas.
- Vendas em transação, com itens e pagamentos e idempotência por `(caixa, clientSaleId)`.

O contrato atualizado para o desenvolvimento Android está em [`docs/CURSOR_ANDROID.md`](docs/CURSOR_ANDROID.md). As migrações `001` a `007` são executadas na inicialização do servidor. A aba **Enviar aos caixas** publica uma revisão para todas ou uma unidade; o app consulta a revisão e confirma após armazenar catálogo e configuração.

A migração `007` cria a biblioteca de mídia, cadastra categorias ainda ausentes a partir dos produtos e enfileira os registros sem mídia; novos cadastros também entram na fila. Imagens de produtos são vinculadas prioritariamente pelo EAN. A busca usa Open Food Facts, respeitando o limite de buscas; um resultado por descrição fica pendente até aprovação. Os banners por categoria podem ser múltiplos, ativos ou inativos, com somente um principal. A primeira geração fica inativa para revisão. O gerador local funciona sem chave externa; uma chave `OPENAI_API_KEY` ativa a geração por IA. Os padrões iniciais são 500 × 500 (produto) e 1200 × 400 (banner, logo ou fundo), com qualidade, fundo, enquadramento e automação ajustáveis na aba Configurações de Mídia. Mudanças valem para os arquivos novos. A Biblioteca aceita logos e fundos e oferece um botão para copiar a URL para Configurações. URLs `/api/media/{id}` são relativas ao domínio do portal e podem ser armazenadas no banco local do Android após baixar o conteúdo.

Ao substituir uma foto de produto ou ativar/inativar um banner de categoria, a mesma transação publica uma nova revisão em `unit_sync_state`. O caixa detecta a revisão em `/api/v1/sync-state`, baixa o catálogo e a mídia nova pela URL exclusiva e confirma por `/api/v1/sync-ack`. O status administrativo mostra quais caixas ainda não confirmaram. O endpoint não envia bytes por push: o Android precisa baixar e guardar a mídia localmente; falhas de download devem ser repetidas em segundo plano.

## Como executar

Node.js 20+, PostgreSQL. Crie um `.env` local a partir de `.env.example` e configure as variáveis no serviço Railway (o Node não lê `.env` automaticamente):

| Variável | Uso |
| --- | --- |
| `DATABASE_URL` | URL do PostgreSQL exclusivo deste projeto. |
| `GOOGLE_CLIENT_ID` | ID do cliente OAuth do login Google. Adicione a origem HTTPS deste portal às origens JavaScript autorizadas no Google Cloud. |
| `ADMIN_EMAIL` | E-mail Google do primeiro administrador. Precisa corresponder ao e-mail autenticado. |
| `PORT` | Porta HTTP, definida automaticamente pela Railway. |
| `OPENAI_API_KEY` | Opcional: geração por IA para banners. Sem ela, o portal cria ilustrações locais. |
| `OPENAI_IMAGE_MODEL` | Opcional: modelo de imagem; padrão `gpt-image-1.5`. |
| `MEDIA_USER_AGENT` | Identificação da integração com Open Food Facts. |

```bash
npm install
npm start
```

O servidor cria as tabelas de `sql/001_initial.sql` na inicialização e insere o primeiro administrador caso ainda não exista. Só configure um e-mail real autorizado; o cadastro é exclusivo deste projeto. Um cadastro antigo não é copiado automaticamente.

## Estrutura de vendas e consulta no portal

A migração `sql/004_sales_saurus.sql` acrescenta a origem e IDs externos às vendas, precisão de quatro casas para a quantidade, identificadores dos itens e pagamentos, além das tabelas `sale_installments`, `sale_tef` e `saurus_register_mappings`. A aba **Vendas** filtra por origem/unidade/ID e abre os detalhes de itens, pagamentos, parcelas e TEF; a aba **Vínculos de origem** associa `(emit_idLoja, mov_numCaixa)` à unidade Facinho e opcionalmente ao caixa local caso uma importação seja solicitada. Os números de origem não são inferidos a partir das siglas das lojas. O projeto não possui conexão com o banco da Cobile, sincronização com ela nem vendas históricas copiadas dela. Nenhum vínculo de loja ou caixa externo é pré-cadastrado.

O endpoint administrativo opcional `POST /api/admin/saurus-sales/import` aceita até 20 vendas por requisição, sob login Google de administrador, com `sales: [{venda, produtos, pagamentos, parcelas, tef}]`. Cada objeto segue o formato Saurus ou uma propriedade `dados` com esses campos. Reenviar o mesmo `mov_idMov` atualiza seus dados e substitui os filhos na mesma transação, sem duplicar. Uma importação solicitada criará apenas os pares de loja/caixa de origem presentes nas vendas recebidas; as vendas ficam sem unidade até que um administrador configure o vínculo. O importador só guarda campos operacionais selecionados; dados pessoais de cliente e vias de comprovantes TEF não são copiados. O envio normal do novo caixa em `POST /api/v1/sales` permanece independente.

## Contrato para o Cursor

Autentique o app com a chave do caixa no cabeçalho `Authorization: Bearer FCX-XXXX-XXXX-XXXX-XXXX`. A chave é gerada ao criar o caixa, vem oculta e pode ser mostrada ou copiada apenas nessa página; após recarregar, não pode ser recuperada. Para um caixa existente, o administrador pode gerar outra chave na aba Caixas, invalidando imediatamente a anterior. As chaves antigas no formato `fcx_...` continuam válidas enquanto não forem substituídas. Guarde a chave em armazenamento seguro da maquininha. **Não coloque a chave no repositório nem inclua dados completos de cartão em `metadata` ou `raw_payload`.** O portal usa centavos inteiros para valores, quantidade decimal de até três casas e datas ISO 8601.

### 1. Catálogo

`GET /api/v1/catalog` retorna um snapshot completo dos produtos ativos da unidade desse caixa, com IDs, códigos, EANs, descrição, categoria, subcategoria, marca, unidade de medida, NCM e preço de venda. O app pode armazenar o snapshot localmente e consultar de novo quando necessário. Produtos de outras unidades não são retornados.

```json
{
  "unitId": "1", "registerId": "2", "generatedAt": "2026-09-27T17:00:00.000Z",
  "products": [{ "id": "10", "external_id": "123", "code": "ABC", "description": "Água 500 ml",
    "category": "Bebidas", "barcodes": ["7890000000000"], "sale_price_cents": "450" }]
}
```

IDs e `bigint` podem chegar como **strings** no JSON. O app deve tratá-los como identificadores, sem converter para ponto flutuante.

### 2. Configurações

`GET /api/v1/config` retorna a unidade e o caixa identificados pelo token e as configurações JSON cadastradas para aquela unidade.

```json
{"unit":{"id":"1","name":"Facinho Parque Atlantic","acronym":"PA","settings":{}},"register":{"id":"2","name":"Caixa 01"}}
```

O formato interno de `settings` será fechado junto com as regras concretas da maquininha; a primeira versão aceita um objeto JSON sem impor campos fiscais ou de pagamento ainda não definidos.

### 3. Envio das vendas

`POST /api/v1/sales` recebe uma venda por solicitação. `clientSaleId` deve ser único e persistente **por caixa**, criado pelo app antes do envio. Se houver falha de conexão, reenviar exatamente o mesmo JSON com o mesmo ID; a resposta traz `duplicate: true` sem duplicar a venda. Se o mesmo ID vier com dados diferentes, retorna HTTP 409.

```json
{
  "clientSaleId": "uuid-gerado-pelo-caixa",
  "occurredAt": "2026-09-27T16:55:00.000Z",
  "status": "APPROVED",
  "totalCents": 900,
  "items": [
    {"productId":"10","barcode":"7890000000000","description":"Água 500 ml",
     "quantity":2,"unitPriceCents":450,"totalCents":900}
  ],
  "payments": [
    {"method":"CREDIT","amountCents":900,"providerReference":"referencia-nao-sensivel"}
  ]
}
```

Para `APPROVED`, soma dos itens, soma dos pagamentos e `totalCents` precisam coincidir. Quantidades multiplicadas por preço são arredondadas para centavos. O servidor ignora qualquer `unitId` ou `registerId` enviado no corpo e usa exclusivamente o token do caixa. Uma venda com `status: "CANCELLED"` é aceita como registro separado (pagamentos totalizando zero); a regra de estorno de uma venda aprovada ainda precisa ser definida antes de ser usada em produção.

Respostas: HTTP 201 `{ "id": "...", "duplicate": false }`, HTTP 200 em repetição idêntica; HTTP 401/403 para token inválido, 400 para dados inválidos, 409 para ID conflitante. Nunca inferir que uma venda foi gravada depois de timeout: reenviar com o mesmo ID.

## Correspondência com cadastros existentes

O esquema foi desenhado tomando como referência o cadastro Saurus e as tabelas compartilhadas do Cobile, **sem conectar os bancos**. Na importação inicial, confirme a origem e integridade dos dados antes de enviar ao novo banco.

| Campo atual | Coluna no portal | Observação |
| --- | --- | --- |
| `pro_idProduto` | `products.external_id` | Identificador externo preservado. |
| `pro_status`, `pro_tpItem` | `products.status`, `item_type` | Estado e tipo. |
| `pro_codProduto`, `pro_descProduto`, `pro_descRegProduto` | `code`, `description`, `registered_description` | Código e descrições. |
| `pro_codNcm` | `ncm` | Código fiscal, sem inventar tributação. |
| `pro_descCategoria`, `pro_descSubcategoria`, `pro_descMarca`, `pro_descMedida` | `category`, `subcategory`, `brand`, `unit_of_measure` | Verificar categorias ausentes antes da carga. |
| `pro_vCompra`, `pro_vCusto` | `purchase_cost_cents`, `cost_cents` | Converter de reais para centavos. |
| `pro_vProd` ou tabela de preços vigente | `unit_products.sale_price_cents` | Validar o preço de cada unidade antes de publicar. |
| `loj_idLoja`, `loj_fant`, `loj_doc` | `units.external_id`, `name`, `document` | Associar a sigla e o número do caixa. |
| Código de barras/EAN | `product_barcodes.barcode` | Vários códigos podem apontar para o mesmo produto. |
| `sys_dUpdate` | `products.source_updated_at` | Guardar atualização da origem em eventual importador. |

`qSaldo` não foi convertido automaticamente em estoque por unidade: é preciso reconciliar a origem desse saldo. Histórico antigo de vendas, usuários e caixas também **não foi copiado**. Uma rotina de migração poderá ler uma exportação revisada do Cobile/Saurus e gravar aqui sem criar dependência entre projetos.

## Segurança e limites desta etapa

O repositório foi criado como **público** no GitHub. Nunca suba `.env`, tokens de caixas, credenciais PostgreSQL ou dados de vendas reais. Token do caixa fica como hash SHA-256 no banco; o valor original aparece só na criação. Login Google do portal consulta `users` local; alterações administrativas são auditadas. Sem integração fiscal, emissão de nota, captura de cartão, baixa de estoque ou reconciliação automática com o Cobile nesta primeira versão.

## Preços e promoções (versão 2)

O produto possui `default_sale_price_cents` (preço padrão). A tabela `unit_products.sale_price_cents` é uma substituição opcional por loja. Produto ativo com preço padrão aparece em todas as unidades, salvo se houver vínculo `unit_products.active=false`; produto sem preço padrão só aparece se possuir preço específico. Para voltar ao padrão, remova o preço da unidade na aba correspondente.

No catálogo de cada caixa, `base_price_cents` é o preço da unidade se cadastrado, caso contrário o preço padrão; `sale_price_cents` é o preço calculado **agora** para uma unidade, `price_source` é `PROMOTION`, `UNIT` ou `DEFAULT`. O retorno também inclui `default_sale_price_cents`, `unit_sale_price_cents`, `promotion_id`, `timeZone: "America/Sao_Paulo"` e a lista `promotions` para essa unidade. Cada promoção contém `scope` (`ALL`/`PRODUCTS`), `product_ids`, `unit_ids`, `type`, parâmetros da regra, `starts_at`, `ends_at`, e, quando recorrente, `weekdays` (0=domingo, 6=sábado), `local_start` e `local_end`. Instantes de início são inclusivos e os de fim exclusivos. O app deve recalcular no momento da venda, pois `sale_price_cents` é apenas a fotografia do instante do download.

Uma promoção ativa e dentro de sua vigência prevalece sobre o preço base. Quando várias atingem o mesmo produto, vence a de maior `priority`; no empate, a específica do produto; persistindo empate, a de maior ID. As promoções **não se acumulam**. Regras de desconto por quantidade valem para unidades inteiras do mesmo produto na mesma venda; itens fracionados não recebem desconto por quantidade. `BUY_N_PAY_M` aplica cada grupo completo de N unidades. `SECOND_UNIT_PRICE` aplica o valor especial a cada segunda unidade de um par. `PERCENT` calcula o desconto sobre o total da linha e arredonda para centavos. Para preço temporário (`PRICE`), a linha usa o novo preço unitário, inclusive quando acima do preço base.

No `POST /api/v1/sales`, cada item pode trazer `discountCents` (padrão 0) e `promotionId`. Envie `unitPriceCents` como o preço unitário antes do desconto para `PERCENT` e regras por quantidade; `totalCents = round(quantity × unitPriceCents) - discountCents`. Em `PRICE`, envie o preço temporário em `unitPriceCents`, com desconto 0. O `totalCents` da venda e a soma dos pagamentos devem refletir esses totais líquidos. O servidor armazena o payload original para auditoria; uma venda offline pode ter uma promoção que já expirou no momento da sincronização.

Exemplo: preço base de R$ 4,99, duas unidades, segunda por R$ 1,99:

```json
{"productId":"10","description":"Produto","quantity":2,"unitPriceCents":499,"discountCents":300,"totalCents":698,"promotionId":"7"}
```

A migração `sql/003_units.sql` cadastra 13 siglas observadas na aba `CARGAS_AUTO` da planilha operacional em 27/09/2026, sem sobrescrever unidades previamente cadastradas. A fonte não continha IDs externos nem situação operacional confiável; revise o campo de status no portal antes de vincular caixas às unidades.
