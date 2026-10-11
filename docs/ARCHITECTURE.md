# Arquitetura inicial

```text
Renderer isolado
  formulário e resultados
          │ IPC com API permitida
          ▼
Electron main
  ├─ diálogo nativo de arquivos
  ├─ inspetor ZIP e SHA-256
  ├─ gerador do contrato v1
  └─ exportador da proposta
          │
          ▼
Diretório exportado
  ├─ submission.json
  └─ packages/<pacote>.zip
```

O renderer não possui acesso direto ao Node.js. `contextIsolation` permanece
habilitado e o preload expõe somente quatro operações: escolher pacote,
validar dados, exportar proposta e consultar a versão do aplicativo.

## Limites de confiança

- O ZIP é entrada não confiável e não é extraído durante a inspeção.
- Caminhos absolutos, travessia de diretórios, nomes com barra invertida,
  entradas cifradas e limites excessivos são rejeitados.
- O pacote exportado é copiado sem modificação e identificado pelo SHA-256.
- A declaração de licença e permissão de redistribuição continua sendo
  confirmada pelo autor e revisada editorialmente.
- A chave de assinatura existe somente na infraestrutura editorial.

## Contrato com o catálogo

O artefato local segue `publisher-submission-v1.schema.json`. O Publisher gera
uma proposta; não gera diretamente um item de catálogo. Após aprovação, o CI
editorial adiciona informações de revisão, gera torrent, publica o pacote e
produz o catálogo assinado consumido pelo Client.

## Nó do desenvolvedor

Ao exportar ou enviar uma proposta, o Publisher registra o caminho e o SHA-256
do ZIP. Ele não cria um torrent concorrente: após a aprovação, baixa o torrent
oficial produzido pela automação editorial e confere se ele aponta para o mesmo
pacote. O gerenciador inicia `aria2c` com DHT, PEX, LPD e trackers habilitados,
mantendo o ZIP no local escolhido pelo desenvolvedor.

O estado possui quatro fases: `awaiting-publication`, `ready`, `seeding` e
`stopped/error`. A GUI mostrará velocidade, peers, bytes enviados e limite de
upload, além de permitir pausar ou remover cada seed. O binário aria2 será
empacotado por plataforma; durante o desenvolvimento, o executável disponível
no `PATH` pode ser usado. Uma etapa futura manterá o nó na bandeja e oferecerá
inicialização automática com consentimento explícito.

## Distribuição

`electron-builder` produz NSIS no Windows, AppImage no Linux e DMG no macOS.
O CI futuro executará testes em `windows-latest`, `ubuntu-latest` e
`macos-latest`, mantendo hashes dos instaladores publicados.
