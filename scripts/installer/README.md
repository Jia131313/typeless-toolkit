# Windows 安装向导语言资源

`ChineseSimplified.isl` 完整取自 Inno Setup 官方仓库的简体中文语言文件，保留原文件中的维护者、联系信息与翻译来源说明；本项目不修改翻译原文。项目专用文案在 `../windows-installer.iss` 的 Messages/CustomMessages 中覆盖。

- 官方翻译索引：https://jrsoftware.org/files/istrans/
- 固定来源：https://github.com/jrsoftware/issrc/blob/f0a3533002d2371c18e4465811dba037b29719f9/Files/Languages/ChineseSimplified.isl
- 维护者：Zhenghan Yang (Kira)
- 翻译维护项目：https://github.com/kira-96/Inno-Setup-Chinese-Simplified-Translation
- 原文件标注要求：Inno Setup 6.5.0+
- 获取日期：2026-10-09

语言文件本身要求 6.5.0+；本项目的动态明暗安装样式使用 Inno Setup 6.7+。英文使用编译器内置的 `Default.isl`；中文在语言列表中优先，并按系统语言或上次安装所选语言自动选择。安装模式、AppId、数据路径和更新交接不因语言改变。
