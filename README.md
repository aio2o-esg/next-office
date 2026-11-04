# Next Office

한컴오피스가 없어도 `.hwp`·`.hwpx` 문서를 한 창에서 열고 고친 뒤, 연 형식 그대로 안전하게 저장하는 한글 문서 편집기입니다.

편집 화면과 문서 엔진은 오픈소스 [rhwp](https://github.com/edwardkim/rhwp)(MIT) 0.8.7을 쓰고, 이 저장소는 그 편집기를 데스크톱 앱(Electron)에 띄워 파일 열기·저장·인쇄를 맡습니다.

> 초기 버전(v0.1)입니다. 저장한 파일은 한컴 한글에서 한 번 열어 확인하세요. 처음 덮어쓸 때 원본은 `<파일 이름>.bak`으로 남습니다.

## 할 수 있는 것

| 기능 | 내용 |
|---|---|
| 열기 | 파일 › 열기(Ctrl+O), 창에 끌어다 놓기, 명령줄 인자. HWP 5.0·HWPX, 한글 3.x(읽기) |
| 편집 | 글자 입력·지우기, 실행 취소, 표·그림·머리말·각주 등 rhwp 편집기의 기능 |
| 글꼴 설정 | 서식 도구 모음의 글꼴·크기·굵게·기울임·밑줄·색, 서식 › 글자 모양(Alt+L, 글자를 고른 뒤), PC에 설치된 글꼴 |
| 저장 | 저장(Ctrl+S)은 연 형식 그대로, 다른 이름으로 저장(Ctrl+Shift+S)에서 HWP↔HWPX |
| 미리보기·인쇄 | 파일 › 인쇄 미리보기(쪽마다 제 용지 크기, 확대·축소), 인쇄(Ctrl+P), PDF로 내보내기 |
| 그 밖 | 새 문서(Alt+N), 최근 파일, 닫기 전 저장 확인, 제목 줄의 수정 표시(*) |

### 저장 안전장치

- 그 실행에서 파일을 **처음 덮어쓰기 전에 원본을 `.bak`으로** 남깁니다. 보관이 실패하면 쓰지 않습니다.
- 쓰기 전에 확장자와 내용 형식이 같은지, HWP는 다시 읽어 쪽수가 같은지, 엔진이 다시 읽을 수 있는지 봅니다. 하나라도 어긋나면 파일을 건드리지 않습니다.
- 임시 파일에 다 쓴 뒤 이름을 바꿔, 쓰다가 멈춰도 원본이 반쯤 덮이지 않습니다.
- **암호 문서·배포용 문서는 저장하지 않습니다.** 그대로 쓰면 문서의 보호가 말없이 풀리기 때문입니다.
- 한글 3.x 문서는 원본을 덮어쓰지 않고 다른 이름의 HWP(5.0)로만 저장합니다.

## 실행

필요한 것: Node.js 20 이상(26.5에서 확인), npm, git, 처음 한 번 인터넷 연결.

```bash
npm install
npm run setup:studio   # rhwp v0.8.7 편집 화면을 받아 vendor/studio에 빌드 (처음 한 번)
npm start
```

문서를 바로 열려면 `npx electron . "문서.hwp"`처럼 경로를 넘깁니다.

## 확인

```bash
npm test         # 단위 시험: 형식 판정, 보호 문서, .bak, 안전한 쓰기
npm run smoke    # 앱 시험: 앱을 띄워 열기→편집→저장→HWPX 저장→미리보기→PDF→글꼴→새 문서
```

`npm run smoke`는 개발용 자동 시험 창구(`NEXT_OFFICE_AUTOMATION=1`)와 디버거 포트 9230·9231을 씁니다. 보통 실행에서는 이 창구가 생기지 않습니다. 완료 기준과 확인 방법은 [SPEC.md](SPEC.md)에 있습니다.

## 구조

```
src/main/main.js           창, 메뉴, 열기·저장·인쇄 흐름, 닫기 전 확인
src/main/file-io.js        형식 판정, 보호 문서 판정, .bak, 안전한 쓰기 (Electron 없이 시험)
src/main/verify.js         저장 전 엔진으로 다시 읽기
src/main/print.js          인쇄용 HTML, 미리보기 창, PDF
src/main/static-server.js  편집기를 내주는 로컬 서버(127.0.0.1)
src/main/recent.js         최근 파일
src/preload.cjs            화면과 메인 프로세스 사이의 좁은 통로
src/preview-preload.cjs    미리보기 창의 단추
src/renderer/              편집기를 embed 모드로 띄우는 화면
scripts/build-studio.mjs   rhwp 편집 화면 빌드
scripts/make-blank.mjs     새 문서용 빈 문서(assets/blank.hwp) 만들기
scripts/smoke-test.mjs     앱 시험
tests/                     단위 시험
```

rhwp 편집기와 SDK는 HTTP(S) 출처끼리만 연결되므로, 앱은 127.0.0.1의 임의 포트에 로컬 서버를 열어 편집 화면을 내줍니다. 문서 내용은 이 서버를 거치지 않고 화면과 편집기 사이에서만 오갑니다. 바깥 웹 글꼴 내려받기는 빌드 때 끕니다.

## 알려진 한계

[SPEC.md의 남은 위험](SPEC.md#남은-위험)을 봅니다. 가장 중요한 것은 rhwp가 1.0 전이라 저장 결과를 한컴 한글에서 확인해야 한다는 점입니다.

## 라이선스

Apache License 2.0 ([LICENSE](LICENSE)). 함께 쓰는 오픈소스와 고지는 [NOTICE](NOTICE)에 있습니다.

본 제품은 한글과컴퓨터의 한글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
