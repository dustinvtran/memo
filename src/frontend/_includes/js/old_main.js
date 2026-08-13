/**
 * @file nil's old main file, preserved
 */
// Show more/less text.
$('.show-more').click(function(){
  var $this = $(this);
  $this.toggleClass('show-more');
  if($this.hasClass('show-more')){
    $this.text('show more');
  } else {
    $this.text('show less');
  }
});

// Bootstrap table
function dateSorter(a, b) {
  var d1 = new Date(a);
  var d2 = new Date(b);
  if (d1 < d2) return -1;
  if (d1 > d2) return 1;
  return 0;
}
function playtimeSorter(a, b) {
  if (a == '' || a == null) return -1;
  if (b == '' || b == null) return 1;
  var d1 = a.replace(/\D/g, "");
  var d2 = b.replace(/\D/g, "");
  d1 = parseInt(d1);
  d2 = parseInt(d2);
  if (d1 < d2) return -1;
  if (d1 > d2) return 1;
  return 0;
}
function yearSorter(a, b, rowa, rowb) {
  var manuala = rowa.year;
  var manualb = rowb.year;
  if (manuala != null) {
    a = manuala;
  }
  if (manualb != null) {
    b = manualb;
  }
  if (a == '' || a == null) return -1;
  if (b == '' || b == null) return 1;
  if (a == 'TBA') return 1;
  if (b == 'TBA') return -1;
  var d1 = parseInt(a);
  var d2 = parseInt(b);
  if (d1 < d2) return -1;
  if (d1 > d2) return 1;
  return 0;
}
// TODO(trandustin): Set up formatters for platform and playtime.
function detailFormatter(index, row) {
  var html = [];
  $.each(row, function (key, value) {
    if (key == 'comments') {
      // Apply marked function from marked package.
      var comment = marked.parse(value);
      html.push('<p><b> Comments:</b> ' + comment + '</p>');
    }
  });
  return html.join('');
}
function linkFormatter(value, row) {
  var id = row.id_wikipedia;
  if (id == '' || id == 'N/A' || id == null) {
    return '<a href="http://en.wikipedia.org/wiki/Special:Search?search=' +
            value + '&go=Go">' + value + '</a>';
  }
  return '<a href="https://en.wikipedia.org/?curid=' + id + '">' +
         value + '</a>';
}
function playtimeFormatter(value, row) {
  if (value == '' || value == 'N/A' || value == null) {
    var title = row.title;
    return '<a href="https://howlongtobeat.com/?q=' + title + '">-</a>';
  }
  var id = row.id_howlongtobeat;
  return '<a href="https://howlongtobeat.com/game?id=' + id + '">' +
         value + '</a>';
}
function staffFormatter(value, row) {
  if (value == '' || value == null) {
    var array = [];
  } else {
    // Convert to string?
    value = value + '';
    var array = value.split('; ');
  }
  var manual = row.staff;
  if (manual != null) {
    array = array.concat(manual.split('; '));
  }
  for (i = 0; i < array.length; i++) {
    // Don't make parentheses content part of the link, e.g.,
    // 'Harmonix (Xbox 360/PS3); Pi Studios (PS2/Wii)'.
    var value = array[i].split(' (');
    // TODO(trandustin): This is temporary since I still use these.
    // Don't add link if term is, e.g., [next action].
    if (value[0].startsWith('[') && value[0].endsWith(']')) {
      var term = value[0];
    } else {
      var term = '<a href="http://en.wikipedia.org/wiki/Special:Search?search=' +
                 value[0] + '&go=Go">' + value[0] + '</a>';
    }
    if (value.length > 1) {
      term = term + ' (' + value[1];
    }
    array[i] = term;
  }
  return array.join('; ');
}
function yearFormatter(value, row) {
  var manual = row.year;
  if (manual != null) {
    return manual;
  }
  return value;
}
window.icons = {
  detailOpen: 'fa-caret-down',
  detailClose: 'fa-caret-up'
};
