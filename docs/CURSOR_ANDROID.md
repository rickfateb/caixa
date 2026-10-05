# Facinho Caixa — contrato para o app Android (28/09/2026)

Este projeto (`rickfateb/caixa`) é independente do Cobile. Base do Portal Dados: `https://portal-caixa-production.up.railway.app`. Use essa base apenas para as APIs do caixa descritas aqui; não use os subdomínios ou o banco da Cobile. O token exclusivo de cada caixa identifica a unidade. O app não escolhe `unitId` no corpo da venda.

## O que já existe no Portal Dados

Banco PostgreSQL próprio, organizado assim:

| Tabela | Papel | Campos principais |
| --- | --- | --- |
| `units` | Unidades | `id`, `external_id`, `name`, `acronym`, `document`, `active` |
| `registers` | Caixas vinculados à unidade | `id`, `unit_id`, `name`, `external_number`, `token_hash`, `active` |
| `products` | Cadastro base | `id`, `external_id`, `status`, `item_type`, `code`, `description`, `registered_description`, `ncm`, `category`, `subcategory`, `brand`, `unit_of_measure`, `default_sale_price_cents`, `active`, `updated_at` |
| `product_barcodes` | Um ou mais EAN/códigos por produto | `barcode`, `product_id` |
| `unit_products` | Preço ou disponibilidade específicos de unidade | `unit_id`, `product_id`, `sale_price_cents`, `active` |
| `product_images` | Até 8 URLs HTTPS por produto, em ordem | `id`, `product_id`, `image_url`, `alt_text`, `sort_order`, `active` |
| `categories` | Imagem da categoria | `id`, `name`, `image_url`, `sort_order`, `active` |
| `banners`, `banner_units` | Oferta visual, vigência e lojas | `id`, `title`, `image_url`, `target_url`, `sort_order`, `starts_at`, `ends_at`, `active`; `banner_units` restringe por loja; sem vínculos significa todas |
| `promotions`, `promotion_products`, `promotion_units` | Preços temporários/descontos | Tipo, prioridade, abrangência, período, dias da semana e horas locais |
| `unit_settings` | Configuração por loja | `unit_id`, `settings` JSON, `updated_at` |
| `unit_sync_state`, `register_sync_status` | Envio e confirmação | Revisão por unidade, solicitante/data; última revisão confirmada e data por caixa |
| `sales` | Cabeçalho de venda | `id`, `source`, `register_id`, `unit_id`, `client_sale_id`, `occurred_at`, `received_at`, `status`, `total_cents`, `payload_hash`, `raw_payload` |
| `sale_items` | Linhas da venda | Produto, código lido, descrição, quantidade, preço unitário, desconto, promoção e total |
| `sale_payments` | Pagamentos | Método, valor, ID local, referência, `metadata`, `simulated` |
| `sale_installments` | Parcelas | Identificador, vínculo ao pagamento, vencimento, valor e status |
| `sale_tef` | Registro de transação | Identificador, vínculo ao pagamento, tipo, status, data e `simulated`; campos reais de autorização/NSU continuam para futura integração |
| `saurus_register_mappings` | Importação histórica separada | Par `(external_store_id, external_register_number)` com vínculo administrativo opcional a unidade/caixa |

As categorias dos produtos são texto em `products.category`; a imagem é associada pelo mesmo nome em `categories.name`. Categoria sem banner principal ainda aparece com `image_url: null`. O Portal recebe imagens, guarda arquivos padronizados no PostgreSQL e fornece URLs HTTPS no catálogo. Imagens de produto usam `image_url` e `images[].imageUrl`; categorias usam `primary_banner_url` e `banners[].imageUrl`. Deixe a interface Android com imagem substituta quando a URL for nula ou falhar.

## Autenticação e sincronização

Em todas as cinco chamadas enviar `Authorization: Bearer FCX-XXXX-XXXX-XXXX-XXXX`. Caixas antigos ainda podem usar `fcx_...` até trocar a chave. Guardar a chave no armazenamento seguro do Android, nunca no código ou nos logs. O portal guarda somente hash da chave. Recriar a chave no Portal invalida a anterior.

1. Ao configurar o caixa, chamar `GET /api/v1/sync-state`, `GET /api/v1/config` e `GET /api/v1/catalog`; persistir as respostas de forma atômica. Só depois, confirmar a revisão com `POST /api/v1/sync-ack`. Sem catálogo válido, não iniciar uma compra.
2. Consultar `GET /api/v1/sync-state` a cada `checkIntervalSeconds` (15 segundos) enquanto o app está conectado. Quando `revision` diferir da última revisão armazenada, baixar catálogo e configuração, persistir ambos e confirmar. A troca de uma imagem aprovada publica uma nova revisão para os caixas. O app deve baixar a mídia apontada pela nova URL e guardá-la localmente para uso offline; uma nova imagem tem uma nova URL, então não deve reutilizar o arquivo em cache da URL antiga. Se o download da mídia falhar, manter a operação e tentar novamente em segundo plano. Além disso, aplicar `appConfig.syncIntervalSeconds` (padrão 300, de 60 a 86400 segundos) a uma sincronização periódica completa, mesmo sem mudança de revisão; oferecer atualização manual.
3. Em caso de falha, manter o último snapshot íntegro e sinalizar que os dados estão desatualizados. Guardar vendas em fila persistente antes de qualquer envio. Ao reconectar, reenviar a **mesma** venda com o mesmo `clientSaleId` e mesmo JSON, sem reconstruir preços nem horário.
4. Dinheiro é inteiro em centavos; IDs `bigint` chegam como strings no JSON; não converter ID para `float`. Horários de eventos são ISO 8601 com fuso; vigência semanal das promoções usa `America/Sao_Paulo`.

### Envio manual do Portal aos caixas

Na aba **Enviar aos caixas**, o administrador escolhe **Todas as unidades** ou uma unidade específica e clica em **Enviar atualização**. O Portal incrementa a revisão apenas das unidades selecionadas. O app busca a nova revisão pela API abaixo e baixa os dados; o painel exibe **Pendente** até a confirmação de cada caixa. Caixa desligado ou sem rede confirmará quando voltar. O botão sinaliza dados novos; não transfere imagens binárias nem afirma entrega antes do ACK.

`GET /api/v1/sync-state`:

```json
{"unitId":"1","registerId":"2","revision":"4","requestedAt":"2026-09-28T01:00:00.000Z","checkIntervalSeconds":15}
```

Após salvar *ambas* as respostas `config` e `catalog` para essa revisão, `POST /api/v1/sync-ack` com `{"revision":"4"}`. Retorna `{"acknowledged":true,"currentRevision":"4","upToDate":true}`; se uma revisão mais nova surgir durante a sincronização, `upToDate` será `false` e o caixa deverá repetir. Nunca confirmar apenas por ter recebido HTTP 200 sem persistir os dados. Uma revisão antiga confirmada não substitui uma confirmação mais nova. As rotas administrativas `POST /api/admin/sync-dispatch` e `GET /api/admin/sync-status` exigem login Google e não são usadas pelo app.

### `GET /api/v1/config`

Resposta representativa:

```json
{
  "unit": {"id":"1","external_id":null,"name":"The Wall II","acronym":"TW","document":null,
    "settings":{"syncIntervalSeconds":300,"theme":{"primaryColor":"#086B3A"},"media":{"logoUrl":null}},"updated_at":"2026-09-28T01:00:00.000Z"},
  "register":{"id":"2","name":"Caixa 01"},
  "appConfig":{"syncIntervalSeconds":300,
    "theme":{"primaryColor":"#086B3A","accentColor":"#22B36D","backgroundColor":"#EAFAF8","textColor":"#173C31"},
    "media":{"logoUrl":null,"welcomeBackgroundUrl":null,"homeBackgroundUrl":null,"checkoutBackgroundUrl":null},
    "paymentMethods":["PIX","CREDIT","DEBIT"]},
  "generatedAt":"2026-09-28T01:00:00.000Z"
}
```

`unit.settings` é o JSON editável pelo administrador; **use `appConfig`**, que já vem com padrões resolvidos. Cores em `#RRGGBB`; URLs de imagem são HTTPS ou `null`. As imagens de categorias e os banners vêm no catálogo. `appConfig.paymentMethods` sempre disponibiliza `PIX`, `CREDIT` e `DEBIT` nesta etapa; `appConfig.paymentMode` é `SIMULATED`. Não há cadastro de CPF, pontos ou vouchers neste projeto.

### `GET /api/v1/catalog`

Retorna um **snapshot completo da unidade do caixa**: `unitId`, `registerId`, `generatedAt`, `timeZone`, `products`, `categories`, `banners`, `promotions`. Exemplo condensado:

```json
{
  "unitId":"1","registerId":"2","generatedAt":"2026-09-28T01:00:00.000Z","timeZone":"America/Sao_Paulo",
  "products":[{"id":"10","external_id":"123","code":"ABC","description":"Coca-Cola 600 ml",
    "registered_description":null,"status":"ATIVO","item_type":null,"ncm":null,"category":"Bebidas",
    "subcategory":"Refrigerantes","brand":"Coca-Cola","unit_of_measure":"UN","barcodes":["7890000000000"],
    "images":[{"id":"21","imageUrl":"https://exemplo.com/coca.jpg","altText":"Coca-Cola 600 ml","sortOrder":0}],
    "default_sale_price_cents":"699","unit_sale_price_cents":null,"base_price_cents":"699",
    "sale_price_cents":699,"price_source":"DEFAULT","promotion_id":null,"updated_at":"2026-09-28T01:00:00.000Z"}],
  "categories":[{"id":"5","name":"Bebidas","image_url":"https://exemplo.com/bebidas.jpg","sort_order":1}],
  "banners":[{"id":"3","title":"Ofertas do dia","image_url":"https://exemplo.com/banner.jpg",
    "target_url":null,"sort_order":1,"starts_at":null,"ends_at":null,"active":true,"unit_ids":[]}],
  "promotions":[]
}
```

Campos de banco PostgreSQL são `snake_case`; `images` usa chaves `camelCase`. Campos opcionais podem ser `null`. Produtos ativos e com preço base aparecem em todas as unidades, exceto quando `unit_products.active=false`; o preço específico da unidade substitui o padrão. Produto sem preço padrão só aparece em unidade com preço próprio. A ordem dos produtos do endpoint é por `id`; o app pode ordenar por descrição na tela. `banners` contém apenas os ativos, vigentes e destinados à unidade. A lista `promotions` inclui promoções ativas ainda não terminadas, inclusive as que começam no futuro. Ao virar o horário de início/fim, recalcular localmente e renovar o catálogo.

Preço: `base_price_cents` = preço da unidade, senão preço padrão. `sale_price_cents` e `price_source` representam apenas o instante do download; escolher e calcular a promoção na hora de fechar o carrinho. Ordem de escolha: maior `priority`, depois promoção específica para produto, depois maior `id`. Não acumular. `PRICE` troca o preço unitário; `PERCENT` desconta o total da linha; `BUY_N_PAY_M` e `SECOND_UNIT_PRICE` só se aplicam a quantidade inteira. Grupos incompletos usam preço normal. `starts_at` inclusivo, `ends_at` exclusivo; `weekdays` usa 0 para domingo; `local_start` inclusivo e `local_end` exclusivo. Arredondar os totais em centavos conforme `src/pricing.js`.

## Pesquisa e telas do Android

Referência visual enviada pelo usuário: reproduzir a direção visual de boas-vindas, início com banner e botão grande de leitura, ofertas, categorias, carrinho e seleção de pagamento; paleta verde, cartões claros, espaço para fotos. Adaptar o visual à marca real. CPF, conta, pontos, voucher, juros e captura verdadeira de pagamentos são elementos ilustrativos da referência e não estão na API; não apresentar como recursos funcionais nesta etapa. A tela de pagamento deve identificar de forma inequívoca que é **simulação**.

Na tela de busca, pesquisar sobre **todo o snapshot local da unidade**, sem depender da paginação de 200 produtos da API administrativa: igualdade exata com qualquer código de barras ou `code`, e substring sem diferenciar maiúsculas/minúsculas ou acentos em `description` e `registered_description`. Ex.: `600` encontra todos os produtos cuja descrição contenha `600`; `coca cola` deve encontrar `Coca-Cola` após normalização de pontuação/espaços. Exibir descrição, imagem (ou placeholder), categoria e preço calculado. Scanner e campo digitável devem conduzir ao mesmo produto; se houver ambiguidade, mostrar resultados. Atualizar quantidade no carrinho e recalcular promoções por linha.

## `POST /api/v1/sales`

Uma venda por solicitação, até 200 itens, 20 pagamentos, 50 parcelas e 50 registros simulados de TEF. Criar `clientSaleId` (UUID persistente) antes de enviar. Para venda aprovada, soma de itens = soma dos pagamentos = `totalCents`; `quantity` positivo até 3 casas decimais; cada linha respeita `totalCents = round(quantity × unitPriceCents) - discountCents`. Quantias em centavos inteiros. O servidor identifica `unit_id`/`register_id` pelo token e grava venda, itens, pagamentos, parcelas e TEF na mesma transação.

Exemplo de compra por crédito **simulado**:

```json
{
  "clientSaleId":"3dd9bd8b-745b-4f58-8358-8cc47a0dcc50",
  "occurredAt":"2026-09-27T22:30:00-03:00",
  "status":"APPROVED",
  "totalCents":698,
  "items":[{"clientLineId":"line-1","productId":"10","externalProductId":"123",
    "productCode":"ABC","unitOfMeasure":"UN","barcode":"7890000000000","description":"Coca-Cola 600 ml",
    "quantity":2,"unitPriceCents":499,"discountCents":300,"totalCents":698,"promotionId":"7"}],
  "payments":[{"clientPaymentId":"payment-1","method":"CREDIT","amountCents":698,"simulated":true,
    "metadata":{"simulation":true,"installmentCount":1}}],
  "installments":[{"paymentLineNumber":1,"clientInstallmentId":"installment-1",
    "dueDate":"2026-10-27","amountCents":698,"status":"SIMULATED"}],
  "tef":[{"paymentLineNumber":1,"clientTransactionId":"sim-tx-1",
    "transactionType":"CREDIT","status":"SIMULATED","simulated":true,
    "occurredAt":"2026-09-27T22:30:00-03:00"}]
}
```

Para `PIX` e `DEBIT`, usar o mesmo formato de pagamento e TEF simulado, trocando `method`/`transactionType` e normalmente sem `installments`. Se houver parcelas de crédito, sua soma deve igualar o valor desse pagamento. `paymentLineNumber` é o índice **1-based** dentro de `payments`; fornecer `clientPaymentId` em pagamentos com parcelas ou TEF. `providerReference` é apenas para referência não sensível futura; nunca inventar NSU/código de autorização ou apresentar Pix real. `metadata` e `raw_payload` são gravados: não enviar PAN, CVV, dados bancários ou comprovantes. A simulação **não liquida dinheiro**. Só marcar `APPROVED` após o usuário concluir a simulação; abandono de carrinho não é venda. `CANCELLED` no contrato atual não é estorno de venda aprovada.

O preço e a promoção aplicados ficam congelados na venda, mesmo quando sincronizada mais tarde. Para `PRICE`, enviar preço temporário em `unitPriceCents` e desconto zero. Para as outras regras, enviar preço base em `unitPriceCents` e desconto em `discountCents`. Enviar `productId`, `externalProductId`, `productCode`, `clientLineId`, `unitOfMeasure`, `barcode`, descrição e `promotionId` quando disponíveis. Os identificadores externos ficam no detalhe da venda para futura análise; não substituem o `productId` local.

Resposta HTTP 201: `{"id":"123","duplicate":false}`. Reenvio do JSON idêntico: HTTP 200 `{"id":"123","duplicate":true}`. Mesmo `(caixa, clientSaleId)` com conteúdo diferente: 409 `SALE_ID_CONFLICT`. 400 para dados ou totais inválidos; 401/403 para chave inválida ou inativa. Após timeout, manter a venda na fila e reenviar o mesmo JSON; HTTP 200/201 permite removê-la. Os IDs de banco são strings.

O Portal administrativo consulta vendas com `GET /api/admin/sales` e detalhes com `GET /api/admin/sales/:id` (essas rotas exigem login Google; o app Android não deve usá-las). O importador Saurus é administrativo e separado das vendas do novo caixa. Não presumir integração automática com Cobile, baixa de estoque, emissão fiscal ou processamento real de Pix/cartão.

## Critérios de verificação no app

- Com chave do caixa TW, catálogo e configuração vêm apenas da TW; a mesma aplicação instalada em outra unidade usa os dados do outro token.
- Produto com preço padrão, substituição por unidade e promoção mostra o preço correto; desconto por quantidade recalcula ao alterar a cesta.
- Pesquisa `600` lista descrições com esse trecho, scanner encontra EAN exato, foto ausente não quebra a tela.
- Banner vigora apenas na loja/período definido; cores, fundos e intervalo mudam após sincronização.
- O botão de envio para uma unidade altera somente a revisão dela; o envio geral afeta todas as unidades ativas. Cada caixa mostra confirmação própria após armazenar catálogo e configuração.
- Pix/crédito/débito estão visivelmente simulados; uma venda registra todos os itens, pagamentos e dados simulados de TEF, e parcelas de crédito quando usadas.
- Sem conexão, o app guarda o JSON original e reenviá-lo não duplica a venda; 409 fica sinalizado para revisão, sem gerar outro ID automaticamente.

## Correção de ativação e pagamentos simulados — 05/10/2026

Nos logs de produção, o app `FacinhoCaixa/2.0` recebeu HTTP 401 em `GET /api/v1/sync-state`: o cabeçalho de autenticação foi rejeitado antes da consulta ao banco. O projeto Android não está neste repositório; conferir seu código no Cursor antes de afirmar que a ativação foi corrigida no dispositivo.

- Enviar a chave em `Authorization: Bearer <chave>`, exatamente uma vez. Aplicar `trim()` ao texto digitado/colado, sem cortar seu comprimento. Não colocar a chave apenas no corpo, query string ou em um cabeçalho diferente. Não registrar a chave em logs.
- Aceitar as chaves novas `FCX-XXXX-XXXX-XXXX-XXXX` e as antigas `fcx_...`; não exigir somente o prefixo antigo. O servidor aceita a chave nova sem hífens ou em minúsculas, restaura sua forma canônica e consulta o mesmo hash cadastrado. Chaves antigas preservam maiúsculas e minúsculas.
- Validar a chave pela API, sem uma expressão regular local que rejeite formatos suportados. HTTP 401 indica ausência/formato incorreto; HTTP 403 indica chave não autorizada ou caixa/unidade inativo. Erros de rede e HTTP 5xx precisam de mensagens próprias. Não transformar todos os erros em “chave inválida”.
- Depois da ativação, ler `appConfig.paymentMethods` e mostrar **Pix simulado**, **Crédito simulado** e **Débito simulado**. Todos devem permitir concluir uma compra de teste, com confirmação explícita de simulação e sem captura financeira.
- Enviar `payments[].simulated: true` com `method` igual a `PIX`, `CREDIT` ou `DEBIT`. Para compatibilidade, a API também aceita essa flag ausente e registra o pagamento como simulado; `false`, tipos inválidos e métodos não suportados recebem `INVALID_SIMULATED_PAYMENT`. Se houver registros de TEF, continuar enviando `status: SIMULATED`, `simulated: true` e referências locais, sem NSU/autorização fictícios.
- Conferir, no APK, ativação com a última chave de um caixa ativo e uma compra em cada método. Ao reenviar uma venda após falha de rede, manter `clientSaleId` e payload idênticos. Se a ativação continuar em 401 após a atualização do portal, inspecionar o envio de `Authorization` no Android; o servidor não deve liberar acesso sem uma chave válida.
