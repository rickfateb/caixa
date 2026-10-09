# Banners da tela inicial — contrato do app Android

O Portal Dados Facinho gerencia banners em duas faixas: `UPPER` (superior) e
`LOWER` (inferior). As imagens podem ser enviadas na aba **Banners** do portal.
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
    "transitionSeconds": 8,
    "order": "RANDOM_NO_IMMEDIATE_REPEAT"
  }
}
```

Os números são exemplos. O portal retorna somente banners ativos, vigentes,
permitidos para a unidade, limitados por faixa e ordenados por `sort_order`.
`GET /api/v1/config` também fornece `bannerDisplay`. Banners antigos sem posição
explícita ficam na faixa `UPPER`.

O app deve baixar e armazenar localmente as imagens junto da versão do catálogo,
confirmar a revisão somente após persistir os dados e manter a última versão
válida em falha de rede. Apresente duas faixas na tela inicial; se uma faixa
vier vazia, aproveite o espaço. Alterne cada faixa de forma independente em
ordem aleatória, sem repetir imediatamente o mesmo banner quando houver mais
de um. A duração de cada imagem é `transitionSeconds` segundos. Não interrompa
um carrinho ou pagamento em andamento para substituir o catálogo.

O app continua nativo em Kotlin e Jetpack Compose. A mudança na tela de busca
(campo maior, botões de código de barras e voz abaixo e categorias em seguida)
pertence ao código Android, não ao portal.
