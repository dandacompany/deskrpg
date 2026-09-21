# DeskRPG Office — 한 컨테이너에 사무실과 두뇌

DeskRPG 는 Hermes Agent 없이는 아무 일도 하지 못합니다. 이 이미지는 둘을 함께 담아,
주소와 키를 손으로 맞추는 과정을 없앱니다. 컨테이너 하나가 뜨면 사무실, 게이트웨이,
Hermes 대시보드가 같이 살아납니다.

| 무엇            | 어디                                                  |
| --------------- | ----------------------------------------------------- |
| 사무실(DeskRPG) | 컨테이너의 3000, 소켓 3001                            |
| Hermes 대시보드 | 9119 — 비밀번호로 잠깁니다                            |
| Hermes API 서버 | 컨테이너 안 127.0.0.1:8642 — **밖으로 열지 않습니다** |
| TUI             | `docker exec -it deskrpg-office hermes`               |

데이터는 볼륨 하나(`/opt/data`)에 모입니다. 프로필과 인격, 칸반, 세션, 업로드가 전부 거기 있습니다.

## 배포

VPS 가 아직 없다면 [여기서 받으세요](https://hostinger.com/DANTE-DOCKER) — 제휴 링크이며 추가 비용은 없습니다.

Hostinger VPS 의 Docker Manager → **Compose from URL** 에 이 파일 주소를 붙여 넣습니다.

```
https://raw.githubusercontent.com/dandacompany/deskrpg/master/deploy/office/docker-compose.yml
```

배포 전에 환경변수 칸을 채웁니다.

```
DASHBOARD_PASSWORD=<대시보드 비밀번호>
OPENROUTER_API_KEY=<모델 제공자 키 — OPENAI_API_KEY 나 ANTHROPIC_API_KEY 도 됩니다>
JWT_SECRET=<긴 임의 문자열 — 비워 두면 컨테이너가 스스로 만듭니다>
```

compose 의 비밀 기본값은 **전부 비어 있습니다.** 공개된 파일에 적힌 기본 비밀은 비밀이 아니기
때문입니다 — 아무도 바꾸지 않으면 이 파일을 읽은 사람 누구나 그 값을 압니다. 그래서
`JWT_SECRET` 은 비워 두면 첫 기동에 임의로 만들어 볼륨에 저장하고(배포마다 다른 값),
`DASHBOARD_PASSWORD` 는 비어 있으면 대시보드가 아예 열리지 않습니다.

비밀은 `openssl rand -hex 32` 로 만듭니다. HTTPS 는 Hostinger 의 Traefik 프로젝트를 한 번
배포해 두면 이 compose 가 알아서 붙습니다.

## 모델 제공자는 선택이 아니다

제공자 키가 없으면 **게이트웨이가 아예 뜨지 않습니다**(실측). 사무실 화면과 대시보드는 열리지만
DeskRPG 가 붙을 문(컨테이너 안 8642)이 열리지 않아 직원을 한 명도 고용할 수 없습니다.
`OPENROUTER_API_KEY`(또는 `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`)를 넣거나
`docker exec -it deskrpg-office hermes model` 로 로그인한 뒤 컨테이너를 다시 시작하세요.
열렸는지는 컨테이너 로그의 `[deskrpg-gateway]` 줄이 알려 줍니다.

## 처음 켠 뒤

1. `https://deskrpg.<내 호스트>` 에서 첫 계정을 만듭니다. **첫 계정이 관리자**입니다.
2. `내 게이트웨이 → 새 게이트웨이` 에서 주소 `http://127.0.0.1:8642` 와 컨테이너가 만든 키를 넣습니다.
   키는 `docker exec deskrpg-office sh -lc 'grep API_SERVER_KEY /opt/data/.env'` 로 확인합니다.
3. 프로필을 추가하면 그게 곧 직원입니다. 채널에 게이트웨이를 연결하고 자리를 주면 대화가 시작됩니다.

모델 제공자 키를 넣지 않았다면 직원이 대답하지 못합니다. 그때는
`docker exec -it deskrpg-office hermes model` 로 로그인합니다.

## 최신 유지

기본값은 **켤 때마다 최신으로 올리기** 입니다. 컨테이너를 재시작하면 Hermes 와 DeskRPG 가
최신이 됩니다. 첫 기동이 몇 분 걸리는 대신 이미지를 다시 받지 않아도 됩니다.

끄려면 `DESKRPG_AUTO_UPDATE=false` 를 넣습니다. 갱신이 멈춰도 기동을 붙잡지 않도록
10분에서 끊습니다(`DESKRPG_UPDATE_TIMEOUT` 으로 조정).

이건 맞바꿈입니다. 켜 두면 재시작할 때마다 npm 과 Hermes 업스트림에서 **그 시점의 최신**을
받습니다 — 손대지 않아도 보안 수정이 따라오는 대신, 공급망을 그 두 출처에 맡기는 것입니다.
검토한 버전만 돌려야 하는 환경이라면 `DESKRPG_AUTO_UPDATE=false` 로 끄고
`OFFICE_IMAGE` 를 버전 태그(`ghcr.io/dandacompany/deskrpg-office:<릴리스 태그>`)로 고정하세요.
그러면 이미지에 담긴 버전만 돕니다.

## 알아 둘 것

- **대시보드는 비밀번호가 없으면 열리지 않습니다.** Hermes 가 2026-06 이후 공개 바인드에
  인증을 강제합니다. 비밀번호를 비워 두면 대시보드만 뜨지 않고 나머지는 정상입니다.
- **Hermes API 포트를 공개하지 마세요.** 그 키를 쥔 쪽은 이 서버에서 에이전트를 실행할 수 있습니다.
  사무실은 같은 컨테이너 안에서 부르므로 밖으로 열 이유가 없습니다.
- **arm64 에서 빌드하지 마세요.** 공식 Hermes 이미지의 `latest` arm64 변종은 2026-06 버전이라
  플러그인이 로드되지 않습니다(실측). 이 이미지는 amd64 로 빌드합니다.
- **볼륨을 지우면 사무실이 사라집니다.** `docker compose down` 은 볼륨을 남기고, `-v` 는 지웁니다.

## 이미지 직접 빌드

```bash
docker buildx build --platform linux/amd64 -t ghcr.io/dandacompany/deskrpg-office:latest --push deploy/office
```

평소에는 손으로 빌드할 일이 없습니다. `.github/workflows/office-image.yml` 이 날짜 태그를 밀 때와
수동 실행(`gh workflow run office-image.yml -f version=<버전>`)에 GHCR 로 굽고, 익명 pull 까지
확인합니다. 공식 Hermes 이미지가 올라갔을 때 릴리스 없이 다시 구우려면 수동 실행을 씁니다.
