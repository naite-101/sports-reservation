/**
 * 本地 SVG 线性图标组件
 *
 * 通过 name 属性引用 /images/icons/ 下的同名 .svg 文件，
 * 统一用 <image> 渲染，避免 emoji 与在线图标字体依赖。
 */
Component({
  externalClasses: ['custom-class'],
  properties: {
    /** 图标文件名（不含 .svg 后缀），如 "badminton" */
    name: {
      type: String,
      value: '',
    },
    /** 图标尺寸，默认 48rpx */
    size: {
      type: String,
      value: '48rpx',
    },
    /** 图标文件扩展名，默认 svg；位图图标用 png */
    ext: {
      type: String,
      value: 'svg',
    },
  },
});
