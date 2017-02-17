// Dependencies
const React = require("react");
const {
  isGrip,
  wrapRender,
} = require("./rep-utils");
const Caption = React.createFactory(require("./caption"));
const PropRep = React.createFactory(require("./prop-rep"));
const { MODE } = require("./constants");
// Shortcuts
const { span } = React.DOM;
/**
 * Renders an map. A map is represented by a list of its
 * entries enclosed in curly brackets.
 */
const GripMap = React.createClass({
  displayName: "GripMap",

  propTypes: {
    object: React.PropTypes.object,
    // @TODO Change this to Object.values once it's supported in Node's version of V8
    mode: React.PropTypes.oneOf(Object.keys(MODE).map(key => MODE[key])),
    objectLink: React.PropTypes.func,
    isInterestingEntry: React.PropTypes.func,
    attachedActorIds: React.PropTypes.array,
    onDOMNodeMouseOver: React.PropTypes.func,
    onDOMNodeMouseOut: React.PropTypes.func,
    onInspectIconClick: React.PropTypes.func,
    title: React.PropTypes.string,
  },

  getTitle: function (object) {
    let title = this.props.title || (object && object.class ? object.class : "Map");
    if (this.props.objectLink) {
      return this.props.objectLink({
        object: object
      }, title);
    }
    return title;
  },

  safeEntriesIterator: function (object, max) {
    max = (typeof max === "undefined") ? 3 : max;
    try {
      return this.entriesIterator(object, max);
    } catch (err) {
      console.error(err);
    }
    return [];
  },

  entriesIterator: function (object, max) {
    // Entry filter. Show only interesting entries to the user.
    let isInterestingEntry = this.props.isInterestingEntry || ((type, value) => {
      return (
        type == "boolean" ||
        type == "number" ||
        (type == "string" && value.length != 0)
      );
    });

    let mapEntries = object.preview && object.preview.entries
      ? object.preview.entries : [];

    let indexes = this.getEntriesIndexes(mapEntries, max, isInterestingEntry);
    if (indexes.length < max && indexes.length < mapEntries.length) {
      // There are not enough entries yet, so we add uninteresting entries.
      indexes = indexes.concat(
        this.getEntriesIndexes(mapEntries, max - indexes.length, (t, value, name) => {
          return !isInterestingEntry(t, value, name);
        })
      );
    }

    let entries = this.getEntries(mapEntries, indexes);
    if (entries.length < mapEntries.length) {
      // There are some undisplayed entries. Then display "more…".
      let objectLink = this.props.objectLink || span;

      entries.push(Caption({
        key: "more",
        object: objectLink({
          object: object
        }, `${mapEntries.length - max} more…`)
      }));
    }

    return entries;
  },

  /**
   * Get entries ordered by index.
   *
   * @param {Array} entries Entries array.
   * @param {Array} indexes Indexes of entries.
   * @return {Array} Array of PropRep.
   */
  getEntries: function (entries, indexes) {
    let {
      objectLink,
      attachedActorIds,
      onDOMNodeMouseOver,
      onDOMNodeMouseOut,
      onInspectIconClick,
    } = this.props;

    // Make indexes ordered by ascending.
    indexes.sort(function (a, b) {
      return a - b;
    });

    return indexes.map((index, i) => {
      let [key, entryValue] = entries[index];
      let value = entryValue.value !== undefined ? entryValue.value : entryValue;

      return PropRep({
        // key,
        name: key,
        equal: ": ",
        object: value,
        // Do not add a trailing comma on the last entry
        // if there won't be a "more..." item.
        delim: (i < indexes.length - 1 || indexes.length < entries.length) ? ", " : "",
        mode: MODE.TINY,
        objectLink,
        attachedActorIds,
        onDOMNodeMouseOver,
        onDOMNodeMouseOut,
        onInspectIconClick,
      });
    });
  },

  /**
   * Get the indexes of entries in the map.
   *
   * @param {Array} entries Entries array.
   * @param {Number} max The maximum length of indexes array.
   * @param {Function} filter Filter the entry you want.
   * @return {Array} Indexes of filtered entries in the map.
   */
  getEntriesIndexes: function (entries, max, filter) {
    return entries
      .reduce((indexes, [key, entry], i) => {
        if (indexes.length < max) {
          let value = (entry && entry.value !== undefined) ? entry.value : entry;
          // Type is specified in grip's "class" field and for primitive
          // values use typeof.
          let type = (value && value.class ? value.class : typeof value).toLowerCase();

          if (filter(type, value, key)) {
            indexes.push(i);
          }
        }

        return indexes;
      }, []);
  },

  render: wrapRender(function () {
    let object = this.props.object;
    let props = this.safeEntriesIterator(object,
      (this.props.mode === MODE.LONG) ? 10 : 3);

    let objectLink = this.props.objectLink || span;
    if (this.props.mode === MODE.TINY) {
      return (
        span({className: "objectBox objectBox-object"},
          this.getTitle(object),
          objectLink({
            className: "objectLeftBrace",
            object: object
          }, "")
        )
      );
    }

    return (
      span({className: "objectBox objectBox-object"},
        this.getTitle(object),
        objectLink({
          className: "objectLeftBrace",
          object: object
        }, " { "),
        props,
        objectLink({
          className: "objectRightBrace",
          object: object
        }, " }")
      )
    );
  }),
});

function supportsObject(grip, type) {
  if (!isGrip(grip)) {
    return false;
  }
  return (grip.preview && grip.preview.kind == "MapLike");
}

// Exports from this module
module.exports = {
  rep: GripMap,
  supportsObject: supportsObject
};
