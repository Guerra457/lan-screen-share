# 🖥️ LAN Screen Share

Compartilhamento de tela com áudio, chat e várias lives ao mesmo tempo, feito para **redes locais e VPNs virtuais** (LAN, [Radmin VPN](https://www.radmin-vpn.com/), Hamachi, Tailscale, ZeroTier…). Sem servidor na internet, sem conta e sem mensalidade: o vídeo vai **direto de um PC para o outro** (P2P via WebRTC).

> Interface inspirada no Discord: lista de membros, cards das lives abertas, chat de texto e nicks.

---

## ✨ Recursos

- **Salas:** uma pessoa cria a sala e as outras entram pelo IP.
- **Várias lives ao mesmo tempo:** todo mundo pode transmitir e assistir mais de uma live ao mesmo tempo.
- **Cards das lives abertas** com miniatura, título, quem está transmitindo e número de espectadores.
- **Áudio do sistema** em estéreo (96, 192 ou 320 kbps), sem processamento de voz.
- **Chat de texto** com nick e cor de cada usuário.
- **Configurações ao vivo:** qualidade, conteúdo, codec, áudio, título e até a tela ou janela transmitida podem ser trocados sem encerrar a live.
- **Seletor de telas e janelas** com busca, ícones e miniaturas atualizadas.
- **Codecs:** H.264, VP8, VP9 e AV1, com estatísticas em tempo real (fps, bitrate, codec, encoder, tempo de codificação, RTT e caminho da conexão).
- **Layout responsivo:** funciona de janela pequena a tela maximizada.

---

## 📥 Como usar (sem instalar nada)

1. Baixe o **`LAN-Screen-Share-Windows.zip`** na aba [**Releases**](../../releases) deste repositório.
2. Extraia o zip e abra **`LAN Screen Share.exe`**.
3. Se o Windows mostrar *"O Windows protegeu seu PC"*, clique em **Mais informações → Executar assim mesmo** (o programa não é assinado digitalmente).
4. Quando o firewall perguntar, permita **redes privadas e públicas**. Radmin e Hamachi às vezes aparecem como rede pública.

> Não precisa instalar o Node.js: o executável já o inclui.

### Criando uma sala (uma pessoa)
1. Digite seu nick e clique em **Criar uma sala**.
2. No painel **Convite**, copie o IP da rede virtual (ex.: `26.x.x.x` no Radmin ou `25.x.x.x` no Hamachi) e envie aos amigos.

### Entrando em uma sala (os outros)
1. Digite seu nick e o IP da sala (ex.: `26.12.34.56`).
2. Se a porta 3000 estava ocupada, o criador verá um aviso com a nova porta. Nesse caso use `IP:porta` (ex.: `26.12.34.56:3001`).

### Transmitindo
1. Clique no botão **🖥️** no canto inferior esquerdo.
2. Escolha a tela ou janela, a qualidade e o áudio, depois clique em **Ir ao vivo**.
3. Para mudar algo durante a live, use **⚙ Configurações** no seu card.

### Assistindo
- As lives abertas aparecem como cards. Clique em **Assistir** (você pode abrir várias).
- Passe o mouse sobre o vídeo para ver os controles de mudo, volume e tela cheia (ou dê dois cliques no vídeo).

---

## 🌐 Redes suportadas

Todos precisam estar na **mesma rede**, real ou virtual:

| Cenário | Funciona? |
|---|---|
| Mesma LAN (mesmo roteador) | ✅ use o IP local (`192.168.x.x`) |
| Radmin VPN / Hamachi / Tailscale / ZeroTier | ✅ use o IP da rede virtual |
| Internet pública, sem VPN | ❌ não suportado (exigiria STUN e abertura de portas) |

O IP da ethernet (`192.168.x.x`) só funciona para quem está no mesmo roteador. Para amigos em outras casas, use uma VPN virtual.

---

## ⚙️ Dicas de desempenho

- Comece com **1080p · 30 fps**. Se ficar fluido, suba para 1080p · 60 fps.
- Cada espectador consome upload de quem transmite: 3 espectadores a 8 Mbps = 24 Mbps de upload.
- Olhe o quadro de estatísticas do seu card:
  - `limite: bandwidth` → a rede (ou a VPN) não aguenta aquele bitrate; reduza a qualidade.
  - `encoder: libvpx` (software) com fps baixo → reduza a resolução ou tente o codec **H.264**.
  - `ms/quadro` maior que `1000 / fps` → o codificador não está dando conta.
- Para jogos, deixe **Conteúdo = Jogo / vídeo**. Para texto e aplicativos, use **Texto / apps**, que prioriza nitidez e tem menos fps.
- Se o vídeo travar ao assistir, aumente o **Buffer de vídeo** em ⚙ Configurações (esquerda, embaixo).
- O Radmin VPN costuma ter mais banda que o Hamachi.

---

## 🧯 Problemas comuns

| Sintoma | O que fazer |
|---|---|
| Não conecta na sala | Confira IP e porta; libere o programa no firewall do Windows (nos dois PCs); confirme que ambos estão na mesma VPN |
| Entrou, mas o vídeo não abre | Quase sempre firewall bloqueando UDP; permita o app em redes privadas **e** públicas |
| "Porta ocupada" | Feche outras cópias do programa; o app já tenta a próxima porta sozinho |
| Sem áudio | Marque o áudio como Alta/Normal nas configurações da live; confira se o espectador não está no mudo (🔇) |
| Não vejo uma aba do navegador | O programa captura **telas e janelas**, não abas; escolha a janela do navegador |
| Um programa não aparece na lista | Se ele roda como administrador, execute o LAN Screen Share como administrador também |

---

## 🛠️ Rodando pelo código-fonte

Requer [Node.js](https://nodejs.org) (versão LTS).

```bash
git clone https://github.com/Guerra457/lan-screen-share.git
cd lan-screen-share
npm install
npm start
```

No Windows, o `iniciar-dev.bat` faz isso por você.

### Gerando um `.exe` único (portable)

```bash
npm run dist
```

O arquivo sai na pasta `dist/` (via [electron-builder](https://www.electron.build/)). No Windows, use o `gerar-exe-unico.bat`.

---

## 🧩 Como funciona

```
┌───────────┐    sinalização (WebSocket)     ┌───────────┐
│ Transmite │ ◄────────── sala/hub ────────► │  Assiste  │
└─────┬─────┘     (chat, lives, nicks)       └─────┬─────┘
      │                                            │
      └──────── vídeo + áudio (WebRTC, P2P) ───────┘
```

- **Sala (hub):** o app de quem cria a sala roda um pequeno servidor WebSocket que cuida de usuários, chat, lista de lives e troca das mensagens de conexão. O vídeo **não** passa por ele.
- **Vídeo e áudio:** captura via `getDisplayMedia` (áudio do sistema com *loopback* do Windows), codificação H.264/VP8/VP9/AV1 e envio por WebRTC com UDP direto entre os PCs, sem STUN.
- **Várias lives:** cada espectador abre uma conexão P2P com cada transmissor que está assistindo.

### Estrutura

```
main.js        processo principal do Electron (janelas, captura, servidor da sala)
preload.js     ponte segura entre o app e a interface
server.js      hub da sala (WebSocket): usuários, chat, lives, sinalização
public/
  index.html   interface
  style.css    estilo
  app.js       lógica (conexão, chat, WebRTC, configurações ao vivo)
```

---

## ⚠️ Limitações conhecidas

- Somente **Windows** (o áudio do sistema usa *loopback* do Windows).
- O programa **não é assinado digitalmente**, por isso o SmartScreen mostra um aviso na primeira execução.
- A codificação de vídeo depende do Chromium embutido no Electron. Em alguns PCs ela ocorre por **software** (CPU), o que limita resoluções altas com 60 fps.
- Não há criptografia além da do próprio WebRTC; o chat e a sinalização trafegam sem TLS. Use apenas em redes de confiança.
- A sala fica no PC de quem a criou: se ele fechar o app, a sala acaba.

---
