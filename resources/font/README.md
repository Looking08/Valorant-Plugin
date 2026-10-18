本目录的字体文件用于把中文正确渲染到图片上。

文件：
  noto-sans-sc-400.woff2   常规
  noto-sans-sc-700.woff2   粗体

来源：Noto Sans SC（Google / Adobe 的思源黑体），经 Fontsource 打包的
      简体中文常用字子集（woff2），仅保留本项目用到的两个字重。

许可证：SIL Open Font License 1.1
        https://openfontlicense.org/
        允许自由使用、修改、再分发（包括商用），要求保留本许可声明，
        且不得单独出售字体文件本身。

⚠️ 不要删这两个文件：docker 版 Yunzai 镜像普遍没有装中文字体，
   删了之后整张图的中文会渲染成方块 □□□（数字和英文仍然正常，
   所以这个故障特别容易被误判成「数据错了」）。
