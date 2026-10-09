# Banners da tela inicial — contrato do app Android

O Portal Dados Facinho gerencia banners em quatro áreas: `UPPER` (borda superior),
`CENTER_UPPER` (central superior), `CENTER_LOWER` (central inferior) e
`LOWER` (borda inferior). As imagens podem ser enviadas na aba **Banners** do portal.
O portal armazena o arquivo, escolhe unidades e vigência, e avisa os caixas
por meio da revisão de sincronização existente.

## Leitura pelo caixa

`GET /api/v1/catalog` com o token Bearer do caixa contém:

```json
{
  "banners": [
    {
      "id": 42,
      "title": "Promoção da semana",
      "image_url": "https://portal-caixa-production.up.railway.app/api/media/123",
      "target_url": null,
      "position": "UPPER",
      "sort_order": 0,
      "unit_ids": [1]
    }
  ],
  "bannerDisplay": {
    "upperCount": 3,
    "lowerCount": 3,
    "centerUpperCount": 3,
    "centerLowerCount": 3,
    "transitionSeconds": 8,
    "order": "RANDOM_NO_IMMEDIATE_REPEAT",
    "productShowcase": {
      "positions": ["CENTER_UPPER", "CENTER_LOWER"],
      "when": "NO_ELIGIBLE_BANNER",
      "transitionSeconds": 3,
      "source": "CATALOG_PRODUCTS_WITH_IMAGE",
      "fields": ["image_url", "description"],
      "order": "RANDOM_NO_IMMEDIATE_REPEAT"
    }
  }
}
```

Os números são exemplos. O portal retorna somente banners ativos, vigentes,
permitidos para a unidade, limitados por faixa e ordenados por `sort_order`.
`GET /api/v1/config` também fornece `bannerDisplay`. Banners antigos sem posição
explícita ficam na faixa `UPPER`.

O app deve baixar e armazenar localmente as imagens junto da versão do catálogo,
confirmar a revisão somente após persistir os dados e manter a última versão
válida em falha de rede. Apresente as quatro áreas conforme o layout abaixo;
nas bordas sem banner, aproveite o espaço. Alterne cada área de forma independente em
ordem aleatória, sem repetir imediatamente o mesmo banner quando houver mais
de um. A duração de cada imagem é `transitionSeconds` segundos. Não interrompa
um carrinho ou pagamento em andamento para substituir o catálogo.

## Alteração solicitada em 09/10/2026 — implementação no Android pelo Cursor

Esta documentação descreve o comportamento a implementar em Kotlin/Jetpack Compose.
O portal e suas APIs oferecem as quatro posições, mas não alteram o APK instalado.

Ordem vertical da tela de iniciar compra:

1. `UPPER`: banners já existentes na borda superior.
2. `CENTER_UPPER`: área marcada em vermelho no print, abaixo do banner de borda e
   acima da identificação da loja (sigla, nome e caixa). Esta área poderá exibir
   o banner da marca Facinho cadastrado no portal.
3. Identificação da loja e botão **Iniciar compra**, sempre visíveis e acessíveis.
4. `CENTER_LOWER`: área marcada em azul, abaixo de **Iniciar compra** e acima do
   banner da borda inferior.
5. `LOWER`: banners já existentes na borda inferior.

Separe os banners por `position`; nunca copie banners de uma área para outra.
Um banner cadastrado em `CENTER_UPPER` só aparece na central superior.
Respeite os limites, unidade, vigência e ativação enviados pelo portal.
Com um só banner elegível, mantenha-o estático. Com vários, alterne conforme
`bannerDisplay.transitionSeconds`, sem repetição consecutiva quando possível.
A configuração atual de 4 segundos continua válida para banners.

### Vitrine automática nas áreas centrais

Decida o conteúdo **independentemente em cada área central**:

- Se houver banner elegível naquela posição, exiba os banners, com prioridade
  sobre os produtos. Isso inclui o banner da marca na central superior.
- Se não houver banner elegível, use os produtos do catálogo local da unidade
  que tenham imagem aprovada (`image_url` não vazio ou uma imagem válida em
  `images[].imageUrl`). O catálogo já filtra produtos ativos e disponíveis na loja.
- Mostre **imagem e descrição** do produto. Troque a cada **3 segundos**;
  o tempo da vitrine é independente do tempo dos banners.
- Use ordem aleatória sem repetição consecutiva quando houver mais de um produto;
  uma lista embaralhada pode percorrer todos antes de reiniciar. Evite mostrar
  o mesmo produto simultaneamente nas duas áreas quando houver alternativas.
- Exclua imagens que não possam ser carregadas. Em modo offline, use somente as
  imagens disponíveis no cache local; nunca apresente um quadro vazio por falha.
- Se houver apenas um produto com imagem válida, mantenha-o estático. Se não houver
  nenhum banner nem produto com imagem válida, recolha essa área e aproveite o espaço.
- Reavalie o conteúdo após sincronização, alteração de vigência e mudança de unidade,
  sem interromper venda ou pagamento. A decisão funciona também com catálogo offline.

### Tamanhos e interação

As imagens atuais de banners são aproximadamente 3:1. Calcule a altura pela largura
disponível, com `ContentScale.Fit`, sem cortar texto/preço nem deformar a imagem.
Para a vitrine, ajuste a foto inteira e a descrição em um cartão responsivo dentro
da área central. Reserve espaço para a identificação da loja e para Iniciar compra;
reduza as áreas publicitárias em telas pequenas antes de comprometer esse botão.
Não use a proporção dos banners como proporção da foto de produto.

Faça transições suaves. A vitrine é informativa: tocar nela não adiciona produto ao
carrinho nem inicia uma venda. O banner sem `target_url` também não executa ação.
Mantenha um temporizador por área apenas enquanto a tela inicial estiver visível;
cancele-o ao iniciar compra, navegar ou enviar o app para segundo plano.

### Verificação no terminal real

Verifique as duas áreas com banners diferentes; marca somente na central superior;
uma área com banner e outra com vitrine; ambas com vitrine; produto único;
nenhum produto com imagem; falha de imagem; operação offline; retorno à tela após
venda; filtros por unidade e vigência. Confirme 3 segundos na vitrine e 4 segundos
nos banners atuais, sem cortes de texto e sem cobrir Iniciar compra.

O app continua nativo em Kotlin e Jetpack Compose. A mudança na tela de busca
(campo maior, botões de código de barras e voz abaixo e categorias em seguida)
pertence ao código Android, não ao portal.
