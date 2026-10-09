# NFC-e de mercadorias no Facinho: base de homologação

Pesquisa e implementação preparatória em 09/10/2026. A prioridade é emitir o cupom das compras de mercadorias feitas nos PDVs. Este código permanece em **homologação, sem valor fiscal**; não houve emissão real, implantação ou alteração dos PDVs Android.

## Documento e estabelecimento

Para o varejo paulista, a prioridade é a **NFC-e, modelo 65**, autorizada pela **SEFAZ-SP**. Desde 01/01/2026, ela substitui o CF-e-SAT nas operações abrangidas. A assinatura digital, o XML, o protocolo de autorização e o DANFE com QR Code compõem o fluxo fiscal; gravar uma venda no portal não representa autorização fiscal. [1][2]

Consultas públicas secundárias identificam o CNPJ **57.423.823/0001-47** como **P & R Mercados Ltda**, Araçatuba/SP, CNAE 4712-1/00 e optante do Simples Nacional. A IE **177.647.515.117** apareceu em cadastro secundário. Esses dados são candidatos à conferência: consultar a situação oficial no Simples, o CADESP e o credenciamento NFC-e antes de cadastrar emitentes. Nenhum emitente real foi ativado automaticamente. [3]

As RC 29539/2024 e 27772/2023 tratam de micromercados em condomínios: a orientação paulista exige inscrição estadual para cada estabelecimento, admitindo pedido de regime especial. São respostas a consulentes específicos e orientam a análise da operação semelhante; não comprovam o enquadramento individual da Facinho. **O processamento pode ser centralizado; a identificação do emitente deve corresponder ao estabelecimento habilitado.** Conferir CNPJ, IE, endereço, CSC, série e eventual regime especial por unidade. [4]

## Reforma tributária e Simples

| Período ou decisão | Consequência para a operação |
| --- | --- |
| 2026 | A cobrança de teste de CBS 0,9% e IBS 0,1% não se aplica aos optantes do Simples. Não somar automaticamente 1% às vendas. [5] |
| 2027 | CBS/IBS passam às regras do Simples, com escolha entre recolhimento no DAS e regime regular para esses tributos. Quem já é optante não precisa renovar apenas para permanecer, ressalvada exclusão futura. [6] |
| Escolha para janeiro a junho de 2027 | A Resolução CGSN 194 prorrogou a opção pelo regime regular de IBS/CBS até **30/10/2026**. Cancelamento da opção: **03/11 a 20/12/2026**. O prazo de ingresso/retorno ao Simples é distinto: 15/10/2026. [7] |
| Mercadorias | NCM, regime, origem, ST e monofásico precisam de revisão por item e vigência. A alíquota zero de IBS/CBS para produtos da cesta básica não torna todo o DAS zero. [8][9] |

Para um mercadinho que vende principalmente a consumidores finais, manter IBS/CBS no DAS é um cenário inicial a comparar com o regime regular, não uma decisão automática. A comparação depende da receita bruta acumulada em 12 meses, receitas segregadas, notas de compras e créditos admitidos, margem e participação de vendas a empresas. O CNPJ, sozinho, não permite calcular a carga tributária ou a economia.

Em 2026, a segregação correta de receitas com ICMS-ST e PIS/Cofins monofásicos continua relevante no PGDAS-D. O cupom precisa preservar a classificação de cada item para viabilizar a apuração. **Este módulo emite documentos de teste; ele não calcula nem entrega PGDAS-D/DAS.** [9]

As orientações da Receita apontam obrigações documentais para o Simples a partir de 01/01/2027. O código bloqueia vendas de 2027 até que perfis e leiautes RTC sejam implementados e testados. Na consulta de 09/10, o Portal NF-e publicou a NT 2025.002 v1.52 e o IT 2025.002 v1.70; o aviso de 05/10 postergou a implantação das NT 2025.002 v1.52, 2026.007 v1.10 e 2026.008 v1.00 para 26/10 em homologação e 16/11 em produção. Atualizar ACBr, schemas, tabelas e regras conforme a data de implantação, sem presumir que instalar o pacote Node atualiza a biblioteca nativa. [10]

## Código reaproveitado e arquitetura

O repositório `rickfateb/caixa` já contém Node.js, Express, PostgreSQL, autenticação dos caixas e `POST /api/v1/sales` com idempotência. O servidor do repositório `facinho` possui administração de unidades/PDVs, mas não implementa esse contrato de recebimento. A integração foi preparada no serviço que já recebe vendas; a unificação de navegação/domínio entre portais é uma etapa própria.

| Projeto explorado | Avaliação |
| --- | --- |
| [ACBrLib-Nodejs oficial](https://github.com/Projeto-ACBr-Oficial/ACBrLib-Nodejs) | Escolhido. Wrapper Node compatível com o servidor existente; usa ACBr para assinatura, schemas, comunicação com SEFAZ e DANFE. Pacote fixado em `@projetoacbr/acbrlib-nfe-node@1.0.11`. |
| [NFePHP/sped-nfe](https://github.com/nfephp-org/sped-nfe) | Alternativa PHP, com LGPLv3/MIT. Acrescentaria serviço PHP; DANFE exige a biblioteca correspondente. |
| [Zeus/DFe.NET](https://github.com/ZeusAutomacao/DFe.NET) | Alternativa .NET, LGPL-2.1; acrescentaria outro runtime. |

O wrapper oficial ACBr é LGPL-2.1. A dependência mantém sua licença; não foram copiados fontes de terceiros para o projeto. A `.so`/`.dll` nativa, suas dependências e os schemas não acompanham esta implementação. O projeto ACBr disponibiliza binários compilados no Clube ACBr PRO e fontes para compilação; versão, distribuição e obrigações de licença devem ser conferidas antes da entrega do executável. Nenhuma assinatura ou compra foi realizada. [11]

```mermaid
flowchart TD
  A["PDV: venda e ID persistente"] --> B["Portal: grava venda e reserva cupom"]
  B --> C["Worker ACBr: assina e transmite"]
  C --> D{"Retorno da SEFAZ"}
  D -->|Autorizado| E["Guarda XML e DANFE; PDV consulta"]
  D -->|Timeout| F["Consulta a mesma chave"]
  F --> D
  D -->|Rejeição ou dúvida| G["Revisão fiscal"]
```

Número, chave, fotografia dos itens e XML assinado são persistidos antes da transmissão. Um timeout mantém o resultado desconhecido e provoca consulta pela mesma chave. Esta etapa não reenvia automaticamente depois de uma consulta inconclusiva; deixa o documento para conciliação, evitando emitir outro cupom para a mesma venda.

## Implementado nesta branch

- Migração `010_fiscal_homologation.sql`: emitentes por unidade, perfis fiscais revisados por produto e documentos com numeração única. Não enfileira histórico antigo.
- `POST /api/v1/sales`: conserva o contrato e a idempotência; devolve também `fiscal`. Sem emitente habilitado, retorna `DISABLED` e mantém a venda operacional.
- Reserva de numeração transacional com bloqueio do emitente e da venda, restrições de unicidade e fotografia fiscal com hash canônico, independente da ordem das chaves no JSONB.
- Worker dedicado; as chamadas síncronas à biblioteca nativa ficam fora do processo HTTP. Bloqueio consultivo do PostgreSQL limita a um worker por banco nesta etapa.
- Assinatura/validação pelo ACBr; autorização reconhecida somente com chave correspondente, ambiente 2, `cStat=100`, protocolo e XML processado. Sucesso do lote não significa autorização do cupom.
- Protocolo armazenado como texto: São Paulo passou a usar 17 posições em produção em 05/10/2026. [1]
- Aba Fiscal com emitentes, perfis revisados, estados dos documentos e download de XML/PDF; API do PDV restrita às próprias vendas.
- Certificado e CSC ficam no runtime do worker; não entram no payload do Android nem no cadastro público do portal.

Estados: `BLOCKED` sem número reservado; `PENDING`; `SIGNED`; `SUBMITTING`; `UNKNOWN`; `AUTHORIZED`; `REJECTED`; `MANUAL`. Falha apenas no PDF conserva a autorização e tenta gerar o DANFE novamente, sem emitir outra nota.

O perfil inicial é restrito a revenda interna SP, CRT 1, CFOP/CSOSN `5102/102` ou `5405/500`, com PIS/Cofins e origem revisados. Isso não cobre todos os tratamentos dos mercadinhos: campos de ICMS-ST retido, FCP, benefícios, outras operações e eventuais particularidades devem ser implementados conforme o cadastro fiscal aprovado. Não converter todo o catálogo para CSOSN 102.

## Contrato para o Android

Autenticação: `Authorization: Bearer <token-do-caixa>`, como nas APIs existentes. Não enviar certificado, senha ou CSC. Não enviar unidade/emitente para trocar a vinculação imposta pelo token.

1. Gerar `clientSaleId` antes do envio e persistir o JSON original. Enviar a venda imediatamente após a confirmação operacional do pagamento. Em timeout HTTP, reenviar o mesmo JSON e o mesmo ID.
2. O `POST /api/v1/sales` retorna, por exemplo, `{ "id":"123", "duplicate":false, "fiscal":{ "status":"PENDING", "environment":2, "hasFiscalValue":false } }`.
3. Consultar `GET /api/v1/sales/:clientSaleId/fiscal` até estado final. Nesta etapa, consultas a cada dois segundos são adequadas ao piloto; ajustar carga e experiência após medir latência real.
4. Quando `AUTHORIZED`, usar a chave/QR Code e baixar `GET /api/v1/sales/:clientSaleId/fiscal/pdf` ou `/xml`. O PDF pode ainda estar pendente de geração; retornar 404 não autoriza nova emissão.
5. Manter os estados de venda/pagamento e documento fiscal separados. `duplicate:true` e HTTP 201 confirmam gravação da venda, não autorização de NFC-e. `hasFiscalValue` é sempre `false` nesta branch.
6. Em `BLOCKED`, `REJECTED` ou `MANUAL`, exibir pendência de homologação e encaminhar para revisão; não inventar número/protocolo nem trocar o ID para tentar emitir novamente.

O Android não foi alterado: seus fontes não estão disponíveis nos repositórios inspecionados. Este contrato permite implementar consulta, comprovante e estados na base local do app.

## Homologação e runtime

Usar um banco de teste separado e dados de teste. A migração é aplicada na inicialização normal do servidor; nenhum emitente é criado por ela. Copiar `.env.fiscal.example` apenas para a configuração privada do worker e preencher os caminhos/segredos fora do Git.

```bash
npm ci
npm test
npm run check
npm start
# Em outro processo, com o mesmo banco de homologação e o runtime configurado:
FISCAL_HOMOLOGATION_WORKER=1 npm run fiscal:worker
```

Requisitos do worker:

| Configuração | Uso |
| --- | --- |
| `DATABASE_URL` | Mesmo banco de homologação do portal. |
| `FISCAL_HOMOLOGATION_WORKER=1` | Habilita exclusivamente ambiente 2. |
| `ACBR_NFE_LIBRARY_PATH` | Biblioteca nativa oficial de NFe/NFCe, compatível com OS/arquitetura e DANFE sem interface gráfica. |
| `ACBR_NFE_SCHEMAS_PATH` | Schemas correspondentes à versão nativa e ao ambiente da SEFAZ. |
| `FISCAL_ACBR_CRYPT_KEY` | Chave privada de proteção da configuração ACBr. |
| `FISCAL_<REF>_PFX_PATH`, `_PFX_PASSWORD` | Arquivo A1 e senha do emitente habilitado. |
| `FISCAL_<REF>_CSC`, `_CSC_ID` | CSC de homologação e identificador com seis dígitos. `<REF>` é `credentialsRef` do emitente. |

Biblioteca, schemas e A1 devem existir no filesystem do worker. O código usa o wrapper oficial em `dist/src`, resposta INI UTF-8, SSL, ambiente 2 e NFC-e 4.00. A1 não deve ficar em volume efêmero sem recuperação; o armazenamento fiscal precisa de backup, controle de acesso e retenção conforme a legislação. [2][11]

Cadastrar o emitente na aba Fiscal usando dados oficiais conferidos, referência da evidência cadastral e uma série de homologação revisada. Cadastrar os produtos usados no piloto com NCM, origem, CFOP, CSOSN, PIS/Cofins, GTIN ou ausência real de GTIN, CEST quando aplicável e informação de tributos aproximados com fonte/versão. Habilitar o emitente de teste depois dessa revisão.

As rotas administrativas usam login Google e exigem administrador nas alterações. Emitente fica vinculado a uma unidade; neste escopo, seus dados e sequência são imutáveis pela API depois da criação, permitindo apenas habilitar/desabilitar. Corrigir configurações erradas no ambiente de teste mediante procedimento controlado antes de reservar números.

## Verificado e limites para produção

**38 testes automatizados passaram**, incluindo validação fiscal, centavos/descontos, quantidade fracionada e padding decimal do PostgreSQL, idempotência, rollback da numeração, hash JSONB, persistência antes do envio, consulta após timeout, recuperação de PDF e isolamento dos arquivos por caixa. Também passaram `npm run check`, verificação sintática da aba Fiscal e `git diff --check`.

Os testes de banco usam PGlite/PostgreSQL em uma conexão. Eles não substituem teste concorrente com múltiplos processos contra o PostgreSQL de implantação. Os testes do emissor usam adaptador e XML sintéticos: **não validam a biblioteca nativa, o certificado, o CSC, o QR Code real, o DANFE real ou uma autorização efetiva na SEFAZ**. O pacote oficial foi instalado e sua importação foi verificada; nenhuma chamada fiscal nativa foi executada.

Antes de operação real, concluir:

1. Situação oficial no Simples, cadastros/IE dos micromercados, credenciamento, séries e CSC por estabelecimento/regime especial; A1 e runtime nativo revisados.
2. Pagamentos reais e conciliação do Android: o portal atual aceita Pix/crédito/débito simulados; o módulo só os admite em homologação. Não tratá-los como confirmação financeira real.
3. Cobertura fiscal do catálogo, ICMS-ST/FCP e demais casos aplicáveis; perfis, CST/cClassTrib, schemas e regras RTC para 2027. A estimativa no DANFE não representa cálculo do DAS.
4. Cancelamento fiscal, inutilização e conciliação de documentos já emitidos pelo Saurus/legado. Marcar uma venda como `CANCELLED` não cancela NFC-e. Não reemitir histórico importado.
5. Contingência fiscal offline de fato: XML assinado no fluxo permitido, DANFE e posterior transmissão nos prazos aplicáveis. A fila comum de vendas offline não substitui esse procedimento. São Paulo admite contingência offline; o módulo ainda não a implementa. [12]
6. Entrega/ impressão de DANFE no Android e aceite do consumidor quando eletrônico; testes de latência, reinício, rejeição, duplicidade, falha de PDF e recuperação com o runtime real. [2]
7. Uma autorização real em homologação e reconciliação do XML/protocolo/QR/DANFE antes de uma versão distinta permitir produção. Nesta branch, trocar uma variável de ambiente não libera ambiente 1: validações e restrições do banco o bloqueiam.

O limite de cinco minutos para preparar/enviar uma venda normal é uma **proteção conservadora desta aplicação**, não uma afirmação de prazo legal geral da NFC-e. Vendas antigas ficam bloqueadas para análise, evitando que sincronização tardia vire emissão retroativa automática. O fluxo final precisa tratar conectividade no momento da compra e contingência fiscal.

## Fontes consultadas

1. [SEFAZ-SP: NFC-e, obrigatoriedade e protocolo de 17 posições](https://portal.fazenda.sp.gov.br/servicos/nfce/).
2. [Portaria SRE 40/2024, texto atualizado](https://legislacao.fazenda.sp.gov.br/Paginas/Portaria-SRE-40-de-2024.aspx).
3. [Econodata: dados públicos da P & R Mercados](https://www.econodata.com.br/consulta-empresa/57423823000147-p-r-mercados-ltda); [cnpj.biz: IE e cadastro secundário](https://cnpj.biz/57423823000147); [consulta oficial do CNPJ](https://www.gov.br/pt-br/servicos/consultar-cadastro-nacional-de-pessoas-juridicas?id=1034&origem=servico).
4. [RC 29539/2024](https://legislacao.fazenda.sp.gov.br/Paginas/RC29539_2024.aspx) e [RC 27772/2023](https://legislacao.fazenda.sp.gov.br/Paginas/RC27772_2023.aspx).
5. [LC 214/2025, art. 348, III, c](https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp214compilado.htm); [CGIBS: Simples e adaptação de 2026](https://cgibs.gov.br/reforma-tributaria-comeca-em-2026-com-periodo-de-adaptacao-destaque-informativo-dos-novos-tributos-e-dispensa-de-penalidades).
6. [Receita: CGSN 190/191, agosto de 2026](https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/agosto/cgsn-atualiza-regras-do-simples-nacional-para-adequacao-a-reforma-tributaria-do-consumo); [Fazenda: continuidade no Simples](https://www.gov.br/fazenda/pt-br/assuntos/noticias/2026/setembro/comecou-nesta-terca-1o-09-o-prazo-para-opcao-pelo-simples-nacional-e-para-a-escolha-do-modelo-de-recolhimento-do-ibs-e-da-cbs-em-2027/), prazos originais posteriormente alterados.
7. [Receita: prorrogação dos prazos, 29/09/2026](https://www.gov.br/receitafederal/pt-br/assuntos/noticias/2026/setembro/simples-nacional-2027-entenda-os-novos-prazos-e-faca-sua-escolha-com-consciencia-e-tranquilidade/).
8. [LC 214/2025: cesta básica, art. 125 e Anexo I](https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp214compilado.htm).
9. [Receita: Manual PGDAS-D, tributação monofásica e ST](https://www8.receita.fazenda.gov.br/SimplesNacional/Arquivos/manual/MANUAL_PGDAS-D_2018_V4.pdf).
10. [Receita: orientações RTC](https://www.gov.br/receitafederal/pt-br/acesso-a-informacao/acoes-e-programas/programas-e-atividades/reforma-tributaria-do-consumo/orientacoes-da-reforma-tributaria); [Portal NF-e: aviso de 05/10 e NTs](https://www.nfe.fazenda.gov.br/portal/informe.aspx?AspxAutoDetectCookieSupport=1&ehCTG=false&page=0&pagesize=30); [Informes Técnicos](https://www.nfe.fazenda.gov.br/portal/listaConteudo.aspx?AspxAutoDetectCookieSupport=1&tipoConteudo=hXzemuyNHW4%3D).
11. [ACBr: wrapper oficial](https://github.com/Projeto-ACBr-Oficial/ACBrLib-Nodejs); [sequência de emissão](https://acbr.sourceforge.io/ACBrLib/ComoemitirumaNFeouNFCe.html); [binários ACBrLibNFe](https://projetoacbr.com.br/pro/downloads/acbrlibnfe/).
12. [SEFAZ-SP: contingência](https://portal.fazenda.sp.gov.br/servicos/nfce/Paginas/Conting%C3%AAncia.aspx); [RC 34105/2026](https://legislacao.fazenda.sp.gov.br/Paginas/RC34105_2026.aspx).

Portais contábeis também foram explorados: [Contábeis, 12/08/2026](https://www.contabeis.com.br/noticias/78700/reforma-tributaria-setembro-vira-mes-decisivo-para-empresas-do-simples/) e [Contábeis, 27/08/2026](https://www.contabeis.com.br/noticias/79011/ibs-e-cbs-no-simples-nacional-o-contador-tem-30-dias-em-setembro-para-decidir-quem-sai-do-das/). Seus prazos de setembro devem ser lidos à luz da atualização oficial de 29/09. Para regras fiscais e datas, prevaleceram as fontes oficiais.
