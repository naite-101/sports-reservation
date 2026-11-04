// 建议 / 问题反馈：本地收集反馈信息（暂不做云端上传）
Page({
  data: {
    content: '',
    maxLength: 200,
    // 反馈类型（单选）
    types: ['产品建议', '功能异常', '预约异常', '界面错位', '死机', '无限加载', '小程序闪退', '黑屏白屏', '其他'],
    typeIndex: -1,
    // 已选图片的本地临时路径，最多 3 张
    images: [],
  },

  // 反馈内容输入，实时更新字数
  onInput(e) {
    this.setData({ content: e.detail.value });
  },

  // 反馈类型单选
  selectType(e) {
    const index = Number(e.currentTarget.dataset.index);
    this.setData({ typeIndex: index });
  },

  // 选择图片（本地预览，最多 3 张）
  chooseImage() {
    const remain = 3 - this.data.images.length;
    if (remain <= 0) {
      wx.showToast({ title: '最多选择 3 张图片', icon: 'none' });
      return;
    }
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const paths = res.tempFiles.map((f) => f.tempFilePath);
        this.setData({ images: this.data.images.concat(paths) });
      },
    });
  },

  // 删除已选图片
  removeImage(e) {
    const index = Number(e.currentTarget.dataset.index);
    const images = this.data.images.slice();
    images.splice(index, 1);
    this.setData({ images });
  },

  // 提交反馈：后端暂无 feedback 接口，先做本地校验 + 提示
  submit() {
    const { content, typeIndex } = this.data;
    if (!content.trim()) {
      wx.showToast({ title: '请填写反馈内容', icon: 'none' });
      return;
    }
    if (typeIndex < 0) {
      wx.showToast({ title: '请选择反馈类型', icon: 'none' });
      return;
    }

    // TODO: 后续接入后端 feedback 接口，提交 content / types[typeIndex] / images
    wx.showToast({ title: '感谢反馈，我们会尽快处理', icon: 'none' });

    // 提交成功后重置表单
    this.setData({ content: '', typeIndex: -1, images: [] });
  },
});
