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
editorial adiciona informações de revisão, valida e publica o torrent recebido,
publica o pacote e
produz o catálogo assinado consumido pelo Client.

O adaptador GitHub cria ou reutiliza o fork da conta autenticada, grava os
artefatos sob `submissions/<id>/<versão>/` e abre um pull request contra o
catálogo oficial. O token fica no cofre criptográfico oferecido pelo Electron e
não é exposto ao renderer depois da conexão. O CI recalcula hash, tamanho e
pieces do torrent antes da revisão editorial.

Pacotes acima de 95 MiB não cabem no Git. Para eles, o Publisher cria no fork
um Release de pré-lançamento `kmp-seed-<id>-<versão>-<sha256[:12]>`, envia o
ZIP como asset e acrescenta a URL ao `url-list` do torrent enviado no pull
request. O `url-list` fica fora do bloco `info`, então o infohash não muda. Esse
webseed (BEP 19) é a semente inicial do swarm: o runner do GitHub e os clientes
conseguem baixar mesmo quando nenhum peer aceita conexões de entrada, e o
torrent continua usando peers sempre que eles estiverem disponíveis. Um asset
já enviado com o mesmo tamanho é reutilizado em reenvios.

## Nó do desenvolvedor

Ao exportar ou enviar uma proposta, o Publisher registra o caminho e o SHA-256
do ZIP, gera um torrent determinístico e começa a semear imediatamente. A
publicação deve reutilizar exatamente esses bytes e o mesmo infohash; o
aplicativo rejeita uma confirmação divergente. O gerenciador inicia `aria2c`
com DHT, PEX, LPD e trackers habilitados, mantendo o ZIP no local escolhido
pelo desenvolvedor.

Um mapeamento UPnP ou NAT-PMP aceito pelo roteador não comprova que a porta
recebe conexões. O nó só é marcado como alcançável depois que um peer com IP
público abre uma conexão até ele (origem `I` no kmp-torrentd). Conexões vindas
do próprio IP externo (NAT loopback) ou do mesmo prefixo IPv6 /64 não contam,
porque vêm de aparelhos atrás do mesmo modem. Se isso não
acontecer em 15 minutos de semeação, a GUI pede para liberar a porta no
roteador.

O estado de distribuição possui `ready`, `checking`, `seeding`, `stopped` e
`error`. O estado editorial, separado, possui `awaiting-publication` e
`published`. A GUI mostrará velocidade, peers, bytes enviados e limite de
upload, além de permitir pausar ou remover cada seed. O binário aria2 será
empacotado por plataforma; durante o desenvolvimento, o executável disponível
no `PATH` pode ser usado. O modo opcional em segundo plano mantém o nó na
bandeja. No GNOME sem suporte a AppIndicator, iniciar novamente o Publisher
restaura a janela da instância única já ativa. O protocolo gráfico escolhido
pelo Electron é preservado para manter a compatibilidade com Wayland e X11.
A inicialização automática é opcional e implica o modo em segundo plano. No
Linux, o Publisher cria uma entrada XDG em `~/.config/autostart` apontando para
o AppImage original; Windows e macOS usam a API de itens de login do Electron.

## Distribuição

`electron-builder` produz NSIS no Windows, AppImage no Linux e DMG no macOS.
O CI futuro executará testes em `windows-latest`, `ubuntu-latest` e
`macos-latest`, mantendo hashes dos instaladores publicados.
